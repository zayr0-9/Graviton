import { newClientId } from './clientId'
import { isNativeShell } from '../platform/clientCapabilities'
import { SOLID_BACKGROUND_COLORS } from './opaqueAppBackground'
import { clearVideoBlobs, deleteVideoBlob, getVideoBlob, storeVideoBlob } from './videoBackgroundDb'

export interface CustomVideoEntry {
  id: string
  mimeType: string
  name: string
  size?: number
  lastModified?: number
  createdAt: number
  /** Whether this video requires light text (dark video) or dark text (light video). Defaults to 'auto' (follows system theme). */
  textColorMode?: 'light' | 'dark' | 'auto'
}

export type BackgroundMode = 'video' | 'color'

export interface BackgroundColorSettings {
  light: string
  dark: string
}

const LINUX_DEFAULT_BACKGROUND_COLORS: BackgroundColorSettings = SOLID_BACKGROUND_COLORS

const TRANSPARENT_DEFAULT_BACKGROUND_COLORS: BackgroundColorSettings = {
  light: 'transparent',
  dark: 'transparent',
}

const isElectronLinux = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  return window.electronAPI?.platform === 'linux'
}

export const DEFAULT_BACKGROUND_COLORS: BackgroundColorSettings = !isNativeShell || isElectronLinux()
  ? LINUX_DEFAULT_BACKGROUND_COLORS
  : TRANSPARENT_DEFAULT_BACKGROUND_COLORS

const HEX_COLOR_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const BACKGROUND_PREFERENCE_KEY = 'yggdrasil_background_preference'
const CUSTOM_VIDEO_LIBRARY_KEY = 'yggdrasil_custom_video_library'
const CUSTOM_VIDEO_ACTIVE_KEY = 'yggdrasil_custom_video_active'
const VIDEO_BACKGROUND_EVENT = 'yggdrasil:video-background-change'

export const VIDEO_BACKGROUND_CHANGE_EVENT = VIDEO_BACKGROUND_EVENT

const dispatchBackgroundChange = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(VIDEO_BACKGROUND_EVENT))
}

const normalizeColorString = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (trimmed.toLowerCase() === 'transparent') {
    return 'transparent'
  }

  const normalizedWithHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  if (!HEX_COLOR_REGEX.test(normalizedWithHash)) return null
  const hex = normalizedWithHash.slice(1)
  const expanded = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex
  return `#${expanded.toUpperCase()}`
}

const normalizeColorSettings = (colors: BackgroundColorSettings): BackgroundColorSettings => ({
  light: normalizeColorString(colors.light) ?? DEFAULT_BACKGROUND_COLORS.light,
  dark: normalizeColorString(colors.dark) ?? DEFAULT_BACKGROUND_COLORS.dark,
})

interface StoredBackgroundPreference {
  mode?: BackgroundMode
  colors?: Partial<BackgroundColorSettings>
}

const readBackgroundPreference = (): { mode: BackgroundMode; colors: BackgroundColorSettings } => {
  if (typeof window === 'undefined') {
    return { mode: 'color', colors: DEFAULT_BACKGROUND_COLORS }
  }

  const stored = safeParse(window.localStorage.getItem(BACKGROUND_PREFERENCE_KEY)) as StoredBackgroundPreference | null
  const normalized: StoredBackgroundPreference = typeof stored === 'object' && stored !== null ? stored : {}
  const mode = normalized.mode === 'video' ? 'video' : 'color'

  const colors = normalizeColorSettings({
    light: normalized.colors?.light ?? DEFAULT_BACKGROUND_COLORS.light,
    dark: normalized.colors?.dark ?? DEFAULT_BACKGROUND_COLORS.dark,
  })

  return { mode, colors }
}

const persistBackgroundPreference = (next: {
  mode?: BackgroundMode
  colors?: BackgroundColorSettings
}) => {
  if (typeof window === 'undefined') return
  const current = readBackgroundPreference()
  const merged = {
    mode: next.mode ?? current.mode,
    colors: normalizeColorSettings(next.colors ?? current.colors),
  }

  try {
    window.localStorage.setItem(BACKGROUND_PREFERENCE_KEY, JSON.stringify(merged))
    dispatchBackgroundChange()
  } catch (error) {
    console.error('Failed to persist background preference', error)
  }
}

export const loadBackgroundMode = (): BackgroundMode => readBackgroundPreference().mode
export const loadBackgroundColors = (): BackgroundColorSettings => readBackgroundPreference().colors
export const persistBackgroundMode = (mode: BackgroundMode, colors?: BackgroundColorSettings) => {
  persistBackgroundPreference({ mode, colors })
}
export const persistBackgroundColors = (colors: BackgroundColorSettings) => {
  persistBackgroundPreference({ colors })
}

export const normalizeHexColor = normalizeColorString

const generateId = newClientId

const safeParse = (value: string | null) => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch (error) {
    console.error('Unable to parse stored value', error)
    return null
  }
}

export const loadSavedVideos = (): CustomVideoEntry[] => {
  if (typeof window === 'undefined') return []

  const raw = safeParse(window.localStorage.getItem(CUSTOM_VIDEO_LIBRARY_KEY))
  if (!Array.isArray(raw)) return []

  return raw
}

const persistLibrary = (videos: CustomVideoEntry[]) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CUSTOM_VIDEO_LIBRARY_KEY, JSON.stringify(videos))
    dispatchBackgroundChange()
  } catch (error) {
    console.error('Failed to persist video library', error)
    throw error
  }
}

export const loadActiveCustomVideoId = (): string | null => {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(CUSTOM_VIDEO_ACTIVE_KEY)
}

export const persistActiveCustomVideoId = (id: string | null) => {
  if (typeof window === 'undefined') return

  try {
    if (id) {
      window.localStorage.setItem(CUSTOM_VIDEO_ACTIVE_KEY, id)
    } else {
      window.localStorage.removeItem(CUSTOM_VIDEO_ACTIVE_KEY)
    }
    dispatchBackgroundChange()
  } catch (error) {
    console.error('Failed to persist active custom video id', error)
  }
}

export const loadActiveCustomVideo = (): CustomVideoEntry | null => {
  const activeId = loadActiveCustomVideoId()
  if (!activeId) return null
  const videos = loadSavedVideos()
  return videos.find(video => video.id === activeId) ?? null
}

export const addCustomVideo = async (
  params: Omit<CustomVideoEntry, 'id' | 'createdAt'> & { id?: string; blob: Blob }
): Promise<CustomVideoEntry> => {
  const videos = loadSavedVideos()
  const { blob, ...metadata } = params
  const entry: CustomVideoEntry = {
    ...metadata,
    id: params.id ?? generateId(),
    createdAt: Date.now(),
  }

  await storeVideoBlob(entry.id, blob)

  const uniqueVideos = [entry, ...videos.filter(video => video.id !== entry.id)]
  persistLibrary(uniqueVideos)

  return entry
}

export const removeCustomVideo = async (id: string) => {
  const videos = loadSavedVideos()
  const filtered = videos.filter(video => video.id !== id)
  persistLibrary(filtered)

  await deleteVideoBlob(id)

  const activeId = loadActiveCustomVideoId()
  if (activeId === id) {
    persistActiveCustomVideoId(null)
  }
}

export const clearCustomVideoLibrary = async () => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(CUSTOM_VIDEO_LIBRARY_KEY)
    persistActiveCustomVideoId(null)
    await clearVideoBlobs()
    dispatchBackgroundChange()
  } catch (error) {
    console.error('Failed to clear custom video library', error)
  }
}

export const loadCustomVideoBlobUrl = async (id: string): Promise<string | null> => {
  try {
    const blob = await getVideoBlob(id)
    if (!blob) return null
    return URL.createObjectURL(blob)
  } catch (error) {
    console.error('Failed to load video blob', error)
    return null
  }
}

/**
 * Gets the current text color mode based on active custom video.
 * Returns 'light' if text should be light (dark video), 'dark' if text should be dark (light video),
 * or 'auto' to follow system theme.
 */
export const getActiveTextColorMode = (): 'light' | 'dark' | 'auto' => {
  const activeVideo = loadActiveCustomVideo()
  return activeVideo?.textColorMode ?? 'auto'
}

/**
 * Updates a custom video's text color mode.
 */
export const updateCustomVideoTextColorMode = (id: string, textColorMode: 'light' | 'dark' | 'auto') => {
  const videos = loadSavedVideos()
  const updated = videos.map(video => (video.id === id ? { ...video, textColorMode } : video))

  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CUSTOM_VIDEO_LIBRARY_KEY, JSON.stringify(updated))
    dispatchBackgroundChange()
  } catch (error) {
    console.error('Failed to update video text color mode', error)
  }
}
