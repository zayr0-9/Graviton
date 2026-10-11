import React, { useEffect, useState } from 'react'
import {
  BackgroundColorSettings,
  BackgroundMode,
  CustomVideoEntry,
  DEFAULT_BACKGROUND_COLORS,
  getActiveTextColorMode,
  loadActiveCustomVideo,
  loadActiveCustomVideoId,
  loadBackgroundColors,
  loadBackgroundMode,
  loadCustomVideoBlobUrl,
  VIDEO_BACKGROUND_CHANGE_EVENT,
} from '../helpers/videoBackgroundStorage'
import { getThemeModeColor, useCustomChatTheme } from './ThemeManager/themeConfig'

// Match the agents pill's CSS tinting without changing Electron's native backdrop.
const getTranslucentCssColor = (color: string, alpha: number): string => {
  const hexMatch = color.match(/^#([0-9a-f]{6})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

const VideoBackground: React.FC = () => {
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const [activeVideoId, setActiveVideoId] = useState<string | null>(() => loadActiveCustomVideoId())
  const [activeVideoMeta, setActiveVideoMeta] = useState<CustomVideoEntry | null>(() => loadActiveCustomVideo())
  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null)
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(() => loadBackgroundMode())
  const [backgroundColors, setBackgroundColors] = useState<BackgroundColorSettings>(() => loadBackgroundColors())
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleBackgroundChange = () => {
      setActiveVideoId(loadActiveCustomVideoId())
      setActiveVideoMeta(loadActiveCustomVideo())
      setBackgroundMode(loadBackgroundMode())
      setBackgroundColors(loadBackgroundColors())
    }

    window.addEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, handleBackgroundChange)
    return () => window.removeEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, handleBackgroundChange)
  }, [])

  useEffect(() => {
    if (backgroundMode !== 'video') {
      setActiveVideoUrl(null)
      return
    }

    let isMounted = true
    let objectUrl: string | null = null

    const loadBlobUrl = async () => {
      if (!activeVideoId) {
        setActiveVideoUrl(null)
        return
      }

      const blobUrl = await loadCustomVideoBlobUrl(activeVideoId)
      if (!isMounted) {
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl)
        }
        return
      }

      if (objectUrl && objectUrl !== blobUrl) {
        URL.revokeObjectURL(objectUrl)
      }
      objectUrl = blobUrl
      setActiveVideoUrl(blobUrl)
    }

    loadBlobUrl()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [activeVideoId, backgroundMode])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return

    const root = document.documentElement
    const updateTheme = () => {
      setIsDarkTheme(root.classList.contains('dark'))
    }

    updateTheme()

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          updateTheme()
          break
        }
      }
    })

    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  // Set CSS class on document root based on video's text color mode
  useEffect(() => {
    if (typeof document === 'undefined') return

    const root = document.documentElement
    const textColorMode =
      backgroundMode === 'video' ? getActiveTextColorMode() : isDarkTheme ? 'light' : 'dark'

    root.classList.remove('video-text-light', 'video-text-dark')

    if (textColorMode === 'light') {
      root.classList.add('video-text-light')
    } else if (textColorMode === 'dark') {
      root.classList.add('video-text-dark')
    }

    return () => {
      root.classList.remove('video-text-light', 'video-text-dark')
    }
  }, [activeVideoMeta, backgroundMode, isDarkTheme])

  const colorBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.appBackgroundColor, isDarkTheme)
    : isDarkTheme
      ? backgroundColors.dark
      : backgroundColors.light

  const hasActiveCustomVideo = backgroundMode === 'video' && Boolean(activeVideoMeta && activeVideoUrl)
  // Native glass remains visible on macOS/Windows. Linux retains its solid
  // fallback for window managers where desktop transparency is unreliable.
  const backgroundStyle: React.CSSProperties = customThemeEnabled
    ? {
        backgroundColor: isDarkTheme ? DEFAULT_BACKGROUND_COLORS.dark : DEFAULT_BACKGROUND_COLORS.light,
        backgroundImage: [
          `radial-gradient(ellipse at 16% 0%, ${getTranslucentCssColor(colorBackgroundColor, 0.18)}, transparent 65%)`,
          `linear-gradient(135deg, ${getTranslucentCssColor(colorBackgroundColor, 0.08)}, transparent 70%)`,
        ].join(', '),
      }
    : { backgroundColor: colorBackgroundColor }

  if (!hasActiveCustomVideo) {
    return (
      <div
        key={colorBackgroundColor}
        className='fixed inset-0 w-full h-full pointer-events-none -z-10 transition-colors duration-300'
        style={backgroundStyle}
        aria-hidden='true'
      />
    )
  }

  return (
    <video
      key={activeVideoUrl}
      autoPlay
      loop
      muted
      className='fixed inset-0 w-full h-full blur-[0px] dark:blur-[1px] 2xl:dark:blur-[1px] 2xl:dark:blur-[1px] object-cover pointer-events-none -z-10'
      aria-hidden='true'
    >
      <source src={activeVideoUrl ?? undefined} type={activeVideoMeta?.mimeType} />
    </video>
  )
}

export default VideoBackground
