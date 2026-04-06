import React, { useCallback, useMemo, useRef, useState } from 'react'
import type { SettingsSectionThemeColors } from './settingsSectionTheme'
import './SendButtonAnimations.css'

export type SendButtonAnimationType =
  | 'pulse-orbit'
  | 'ellipsis-flow'
  | 'liquid-fill'
  | 'neutral-bond'
  | 'geom-aperture'
  | 'neural-flux'
  | 'data-drift'
  | 'inertia'
  | 'binary-swap'
  | 'pulse-freq'

export type StreamingAnimationType =
  | 'data-wave'
  | 'digital-breath'
  | 'neural-fragments'
  | 'binary-flow'
  | 'prism-bloom'
  | 'orbit-rings'
  | 'shard-sweep'

export const SEND_BUTTON_ANIMATION_STORAGE_KEY = 'chat:sendButtonAnimation'
export const SEND_BUTTON_COLOR_STORAGE_KEY = 'chat:sendButtonColor'
export const STREAMING_ANIMATION_STORAGE_KEY = 'chat:streamingAnimation'
export const STREAMING_COLOR_STORAGE_KEY = 'chat:streamingAnimationColor'
export const STREAMING_LIGHT_COLOR_STORAGE_KEY = 'chat:streamingAnimationLightColor'
export const STREAMING_DARK_COLOR_STORAGE_KEY = 'chat:streamingAnimationDarkColor'
export const STREAMING_SPEED_STORAGE_KEY = 'chat:streamingAnimationSpeed'

const SEND_BUTTON_ANIMATIONS: { id: SendButtonAnimationType; name: string }[] = [
  { id: 'pulse-orbit', name: 'Pulse Orbit' },
  { id: 'ellipsis-flow', name: 'Ellipsis Flow' },
  { id: 'liquid-fill', name: 'Liquid Fill' },
  { id: 'neutral-bond', name: 'Neutral Bond' },
  { id: 'geom-aperture', name: 'Geometric Aperture' },
  { id: 'neural-flux', name: 'Neural Flux' },
  { id: 'data-drift', name: 'Data Drift' },
  { id: 'inertia', name: 'Inertia' },
  { id: 'binary-swap', name: 'Binary Swap' },
  { id: 'pulse-freq', name: 'Pulse Freq' },
]

const STREAMING_ANIMATIONS: { id: StreamingAnimationType; name: string; description: string }[] = [
  {
    id: 'data-wave',
    name: 'Data Wave',
    description: '8×2 cube grid that pulses, grows, and twists in a staggered wave.',
  },
  {
    id: 'digital-breath',
    name: 'Digital Breath',
    description: 'Outlined squares expand and contract asynchronously with a light, modern feel.',
  },
  {
    id: 'neural-fragments',
    name: 'Neural Fragments',
    description: 'Floating fragments spin with subtle depth and glow like a thinking mesh.',
  },
  {
    id: 'binary-flow',
    name: 'Binary Flow',
    description: 'Columns of bits slide vertically with shifting opacity like streaming data.',
  },
  {
    id: 'prism-bloom',
    name: 'Prism Bloom',
    description: 'Diamond prisms flare outward and fold back like a crystalline pulse.',
  },
  {
    id: 'orbit-rings',
    name: 'Orbit Rings',
    description: 'A tiny core with rotating rings and satellites for a futuristic signal look.',
  },
  {
    id: 'shard-sweep',
    name: 'Shard Sweep',
    description: 'Angular shards sweep diagonally in layered passes like scanning fragments.',
  },
]

const TAILWIND_COLORS = [
  { name: 'White', value: '#ffffff' },
  { name: 'Slate', value: '#64748b' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Purple', value: '#a855f7' },
]

export const getStoredSendButtonAnimation = (): SendButtonAnimationType => {
  try {
    const stored = localStorage.getItem(SEND_BUTTON_ANIMATION_STORAGE_KEY)
    if (stored && SEND_BUTTON_ANIMATIONS.some(animation => animation.id === stored)) {
      return stored as SendButtonAnimationType
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'pulse-orbit'
}

export const getStoredSendButtonColor = (): string => {
  try {
    const stored = localStorage.getItem(SEND_BUTTON_COLOR_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // Ignore localStorage errors
  }
  return '#ffffff'
}

export const getStoredStreamingAnimation = (): StreamingAnimationType => {
  try {
    const stored = localStorage.getItem(STREAMING_ANIMATION_STORAGE_KEY)
    if (stored && STREAMING_ANIMATIONS.some(animation => animation.id === stored)) {
      return stored as StreamingAnimationType
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'data-wave'
}

export const getStoredStreamingColor = (): string => {
  try {
    const stored = localStorage.getItem(STREAMING_COLOR_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // Ignore localStorage errors
  }
  return '#ef4444'
}

export const getStoredStreamingLightColor = (): string => {
  try {
    const stored = localStorage.getItem(STREAMING_LIGHT_COLOR_STORAGE_KEY)
    if (stored) return stored
    const legacy = localStorage.getItem(STREAMING_COLOR_STORAGE_KEY)
    if (legacy) return legacy
  } catch {
    // Ignore localStorage errors
  }
  return '#ef4444'
}

export const getStoredStreamingDarkColor = (): string => {
  try {
    const stored = localStorage.getItem(STREAMING_DARK_COLOR_STORAGE_KEY)
    if (stored) return stored
    const legacy = localStorage.getItem(STREAMING_COLOR_STORAGE_KEY)
    if (legacy) return legacy
  } catch {
    // Ignore localStorage errors
  }
  return '#ffffff'
}

export const getStoredStreamingSpeed = (): number => {
  try {
    const stored = localStorage.getItem(STREAMING_SPEED_STORAGE_KEY)
    const parsed = stored ? Number.parseFloat(stored) : Number.NaN
    if (Number.isFinite(parsed)) {
      return Math.max(0.5, Math.min(2, parsed))
    }
  } catch {
    // Ignore localStorage errors
  }
  return 1
}

export const saveSendButtonAnimation = (animation: SendButtonAnimationType): void => {
  try {
    localStorage.setItem(SEND_BUTTON_ANIMATION_STORAGE_KEY, animation)
    window.dispatchEvent(new CustomEvent('sendButtonAnimationChange', { detail: animation }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveSendButtonColor = (color: string): void => {
  try {
    localStorage.setItem(SEND_BUTTON_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('sendButtonColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveStreamingAnimation = (animation: StreamingAnimationType): void => {
  try {
    localStorage.setItem(STREAMING_ANIMATION_STORAGE_KEY, animation)
    window.dispatchEvent(new CustomEvent('streamingAnimationChange', { detail: animation }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveStreamingColor = (color: string): void => {
  try {
    localStorage.setItem(STREAMING_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('streamingAnimationColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveStreamingLightColor = (color: string): void => {
  try {
    localStorage.setItem(STREAMING_LIGHT_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('streamingAnimationLightColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveStreamingDarkColor = (color: string): void => {
  try {
    localStorage.setItem(STREAMING_DARK_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('streamingAnimationDarkColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveStreamingSpeed = (speed: number): void => {
  try {
    const next = Math.max(0.5, Math.min(2, speed))
    localStorage.setItem(STREAMING_SPEED_STORAGE_KEY, String(next))
    window.dispatchEvent(new CustomEvent('streamingAnimationSpeedChange', { detail: next }))
  } catch {
    // Ignore localStorage errors
  }
}

const SendButtonPreview: React.FC<{ animationType: SendButtonAnimationType; bgColor: string }> = ({
  animationType,
  bgColor,
}) => {
  const style = { '--send-btn-bg': bgColor } as React.CSSProperties

  switch (animationType) {
    case 'ellipsis-flow':
      return (
        <div className='send-btn-preview ellipsis-flow' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    case 'data-drift':
      return (
        <div className='send-btn-preview data-drift' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    case 'binary-swap':
      return (
        <div className='send-btn-preview binary-swap' style={style}>
          <span></span>
          <span></span>
        </div>
      )
    case 'pulse-freq':
      return (
        <div className='send-btn-preview pulse-freq' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    default:
      return <div className={`send-btn-preview ${animationType}`} style={style}></div>
  }
}

const buildStreamingStyle = (
  animationType: StreamingAnimationType,
  color: string,
  speed: number,
  mode: 'preview' | 'live'
): React.CSSProperties => {
  const clampedSpeed = Math.max(0.5, Math.min(2, speed))
  const baseDuration = 1.4 / clampedSpeed
  const isOrbitRings = animationType === 'orbit-rings'

  return {
    '--stream-anim-color': color,
    '--stream-duration': `${baseDuration}s`,
    '--stream-cell-size': mode === 'preview' ? '8px' : '10px',
    '--stream-gap': mode === 'preview' ? '4px' : '5px',
    '--stream-width': isOrbitRings ? (mode === 'preview' ? '96px' : '112px') : mode === 'preview' ? '148px' : '182px',
    '--stream-height': isOrbitRings ? (mode === 'preview' ? '30px' : '36px') : mode === 'preview' ? '18px' : '22px',
    '--stream-columns': isOrbitRings ? '1' : '12',
  } as React.CSSProperties
}

const StreamingAnimationVisual: React.FC<{
  animationType: StreamingAnimationType
  color: string
  speed: number
  mode: 'preview' | 'live'
  className?: string
}> = ({ animationType, color, speed, mode, className }) => {
  const style = buildStreamingStyle(animationType, color, speed, mode)
  const cellCount = animationType === 'orbit-rings' ? 0 : 12
  const columnCount = animationType === 'binary-flow' ? 10 : 8

  if (animationType === 'binary-flow') {
    return (
      <div className={`streaming-anim streaming-${animationType} ${mode} ${className ?? ''}`.trim()} style={style}>
        {Array.from({ length: columnCount }).map((_, index) => (
          <div
            key={index}
            className='stream-col'
            style={
              {
                ['--i' as string]: index,
                animationDelay: `${index * 0.05}s`,
              } as React.CSSProperties
            }
          >
            <span className='stream-bit top'></span>
            <span className='stream-bit bottom'></span>
          </div>
        ))}
      </div>
    )
  }

  if (animationType === 'orbit-rings') {
    return (
      <div className={`streaming-anim streaming-${animationType} ${mode} ${className ?? ''}`.trim()} style={style}>
        <span className='stream-core'></span>
        <span className='stream-ring ring-a'></span>
        <span className='stream-ring ring-b'></span>
        <span className='stream-ring ring-c'></span>
        {Array.from({ length: 4 }).map((_, index) => (
          <span
            key={index}
            className={`stream-satellite sat-${index + 1}`}
            style={{ animationDelay: `${index * 0.12}s` } as React.CSSProperties}
          ></span>
        ))}
      </div>
    )
  }

  return (
    <div className={`streaming-anim streaming-${animationType} ${mode} ${className ?? ''}`.trim()} style={style}>
      {Array.from({ length: cellCount }).map((_, index) => (
        <span
          key={index}
          className='stream-cell'
          style={
            {
              ['--i' as string]: index,
              animationDelay: `${index * 0.05}s`,
            } as React.CSSProperties
          }
        ></span>
      ))}
    </div>
  )
}

const SettingColorRow: React.FC<{
  label?: string
  selectedColor: string
  onSelectColor: (color: string) => void
  colorPickerRef: React.RefObject<HTMLInputElement>
  sectionThemeColors?: SettingsSectionThemeColors | null
}> = ({ label = 'Color', selectedColor, onSelectColor, colorPickerRef, sectionThemeColors = null }) => (
  <div className='space-y-2'>
    <span
      className='text-xs font-medium text-neutral-600 dark:text-neutral-100'
      style={sectionThemeColors ? { color: sectionThemeColors.bodyText } : undefined}
    >
      {label}
    </span>
    <div className='flex flex-wrap items-center gap-2'>
      {TAILWIND_COLORS.map(color => {
        const isSelected = selectedColor === color.value

        return (
          <button
            key={color.value}
            type='button'
            onClick={() => onSelectColor(color.value)}
            className='flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:focus-visible:ring-violet-500/40'
            style={{
              backgroundColor: color.value,
              boxShadow: isSelected
                ? `0 0 0 2px ${sectionThemeColors?.primaryButtonBg ?? '#3b82f6'}`
                : color.value.toLowerCase() === '#ffffff'
                  ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.12)'
                  : 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
            }}
            title={color.name}
          />
        )
      })}
      <button
        type='button'
        onClick={() => colorPickerRef.current?.click()}
        className='flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:focus-visible:ring-violet-500/40'
        style={{
          background: !TAILWIND_COLORS.some(color => color.value === selectedColor)
            ? selectedColor
            : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
          boxShadow: !TAILWIND_COLORS.some(color => color.value === selectedColor)
            ? `0 0 0 2px ${sectionThemeColors?.primaryButtonBg ?? '#3b82f6'}`
            : 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)',
        }}
        title='Custom color'
      >
        <input
          ref={colorPickerRef}
          type='color'
          value={selectedColor}
          onChange={e => onSelectColor(e.target.value)}
          className='sr-only'
        />
      </button>
    </div>
  </div>
)

type SendButtonAnimationSettingsProps = {
  sectionThemeColors?: SettingsSectionThemeColors | null
}

export const SendButtonAnimationSettings: React.FC<SendButtonAnimationSettingsProps> = ({
  sectionThemeColors = null,
}) => {
  const [sendButtonExpanded, setSendButtonExpanded] = useState(false)
  const [streamingExpanded, setStreamingExpanded] = useState(false)
  const [selectedSendButtonAnimation, setSelectedSendButtonAnimation] =
    useState<SendButtonAnimationType>(getStoredSendButtonAnimation)
  const [selectedSendButtonColor, setSelectedSendButtonColor] = useState<string>(getStoredSendButtonColor)
  const [selectedStreamingAnimation, setSelectedStreamingAnimation] =
    useState<StreamingAnimationType>(getStoredStreamingAnimation)
  const [selectedStreamingLightColor, setSelectedStreamingLightColor] = useState<string>(getStoredStreamingLightColor)
  const [selectedStreamingDarkColor, setSelectedStreamingDarkColor] = useState<string>(getStoredStreamingDarkColor)
  const [selectedStreamingSpeed, setSelectedStreamingSpeed] = useState<number>(getStoredStreamingSpeed)
  const sendButtonColorPickerRef = useRef<HTMLInputElement>(null)
  const streamingLightColorPickerRef = useRef<HTMLInputElement>(null)
  const streamingDarkColorPickerRef = useRef<HTMLInputElement>(null)

  const handleSelectSendButtonAnimation = useCallback((animation: SendButtonAnimationType) => {
    setSelectedSendButtonAnimation(animation)
    saveSendButtonAnimation(animation)
  }, [])

  const handleSelectSendButtonColor = useCallback((color: string) => {
    setSelectedSendButtonColor(color)
    saveSendButtonColor(color)
  }, [])

  const handleSelectStreamingAnimation = useCallback((animation: StreamingAnimationType) => {
    setSelectedStreamingAnimation(animation)
    saveStreamingAnimation(animation)
  }, [])

  const handleSelectStreamingLightColor = useCallback((color: string) => {
    setSelectedStreamingLightColor(color)
    saveStreamingLightColor(color)
  }, [])

  const handleSelectStreamingDarkColor = useCallback((color: string) => {
    setSelectedStreamingDarkColor(color)
    saveStreamingDarkColor(color)
  }, [])

  const handleStreamingSpeedChange = useCallback((speed: number) => {
    const next = Math.max(0.5, Math.min(2, speed))
    setSelectedStreamingSpeed(next)
    saveStreamingSpeed(next)
  }, [])

  const selectedSendButtonAnimationName = useMemo(
    () => SEND_BUTTON_ANIMATIONS.find(animation => animation.id === selectedSendButtonAnimation)?.name || 'Pulse Orbit',
    [selectedSendButtonAnimation]
  )

  const selectedStreamingAnimationName = useMemo(
    () => STREAMING_ANIMATIONS.find(animation => animation.id === selectedStreamingAnimation)?.name || 'Data Wave',
    [selectedStreamingAnimation]
  )

  const isDarkModePreview =
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : false
  const activeStreamingPreviewColor = isDarkModePreview ? selectedStreamingDarkColor : selectedStreamingLightColor
  const sectionCardStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.cardBg,
        borderColor: sectionThemeColors.cardBorder,
      }
    : undefined
  const innerCardStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.innerCardBg,
        borderColor: sectionThemeColors.innerCardBorder,
      }
    : undefined
  const badgeStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.badgeBg,
        color: sectionThemeColors.badgeText,
      }
    : undefined
  const titleStyle = sectionThemeColors ? { color: sectionThemeColors.titleText } : undefined
  const bodyStyle = sectionThemeColors ? { color: sectionThemeColors.bodyText } : undefined
  const buttonStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.buttonBg,
        color: sectionThemeColors.buttonText,
      }
    : undefined
  const previewSurfaceStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.codeBg,
        color: sectionThemeColors.codeText,
      }
    : undefined
  const selectedCardStyle = sectionThemeColors
    ? {
        backgroundColor: sectionThemeColors.primaryButtonBg,
        color: sectionThemeColors.primaryButtonText,
      }
    : undefined
  const defaultCardStyle = sectionThemeColors ? { backgroundColor: sectionThemeColors.listBg } : undefined
  const selectedTextStyle = sectionThemeColors ? { color: sectionThemeColors.primaryButtonText } : undefined
  const itemTitleStyle = sectionThemeColors ? { color: sectionThemeColors.listItemTitleText } : undefined
  const itemMetaStyle = sectionThemeColors ? { color: sectionThemeColors.listItemMetaText } : undefined

  return (
    <div className='space-y-3'>
      <div className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10' style={sectionCardStyle}>
        <button
          type='button'
          onClick={() => setSendButtonExpanded(prev => !prev)}
          className='group flex w-full items-start justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-150 hover:bg-neutral-100/80 active:scale-[0.99] active:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-black/10 dark:active:bg-neutral-800/60 dark:focus-visible:ring-violet-500/40'
        >
          <div className='flex min-w-0 items-start gap-3'>
            <div
              className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300'
              style={
                sectionThemeColors
                  ? {
                      backgroundColor: sectionThemeColors.accentBg,
                      color: sectionThemeColors.accentText,
                    }
                  : undefined
              }
            >
              <i className='bx bx-paper-plane text-lg' />
            </div>
            <div className='min-w-0'>
              <p className='text-sm font-medium text-stone-700 dark:text-neutral-100' style={titleStyle}>
                Send Button Animation
              </p>
              <p className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
                Choose the animation shown in the send button while the assistant is generating.
              </p>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <div
              className='h-4 w-4 rounded-md'
              style={{
                backgroundColor: selectedSendButtonColor,
                boxShadow:
                  selectedSendButtonColor.toLowerCase() === '#ffffff'
                    ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.12)'
                    : 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
              }}
            />
            <span
              className='hidden rounded-full bg-neutral-200/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-100 sm:inline-flex'
              style={badgeStyle}
            >
              {selectedSendButtonAnimationName}
            </span>
            <i
              className={`bx bx-chevron-down shrink-0 text-2xl text-neutral-500 dark:text-neutral-100 transition-transform duration-200 ${sendButtonExpanded ? 'rotate-180' : ''}`}
              style={bodyStyle}
            />
          </div>
        </button>

        {sendButtonExpanded && (
          <div className='space-y-3 px-3 pb-3 pt-1'>
            <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
              <SettingColorRow
                selectedColor={selectedSendButtonColor}
                onSelectColor={handleSelectSendButtonColor}
                colorPickerRef={sendButtonColorPickerRef}
                sectionThemeColors={sectionThemeColors}
              />
            </div>

            <div className='space-y-2'>
              <span className='text-xs font-medium text-neutral-600 dark:text-neutral-100' style={bodyStyle}>
                Animation Style
              </span>
              <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5'>
                {SEND_BUTTON_ANIMATIONS.map(animation => {
                  const isSelected = selectedSendButtonAnimation === animation.id

                  return (
                    <button
                      key={animation.id}
                      type='button'
                      onClick={() => handleSelectSendButtonAnimation(animation.id)}
                      className={`flex flex-col items-center gap-2 rounded-xl px-3 py-3 text-center text-neutral-700 dark:text-neutral-100 transition-all duration-150 hover:bg-white/80 active:scale-[0.98] active:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-900/40 dark:active:bg-neutral-900/50 dark:focus-visible:ring-violet-500/40 ${
                        isSelected
                          ? 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-100'
                          : 'bg-neutral-100/70 dark:bg-neutral-900/25'
                      }`}
                      style={isSelected ? selectedCardStyle : defaultCardStyle}
                      title={animation.name}
                    >
                      <div className='rounded-xl px-3 py-3' style={previewSurfaceStyle}>
                        <SendButtonPreview animationType={animation.id} bgColor={selectedSendButtonColor} />
                      </div>
                      <span
                        className='w-full truncate text-xs font-medium'
                        style={isSelected ? selectedTextStyle : itemTitleStyle}
                      >
                        {animation.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10' style={sectionCardStyle}>
        <button
          type='button'
          onClick={() => setStreamingExpanded(prev => !prev)}
          className='group flex w-full items-start justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-150 hover:bg-neutral-100/80 active:scale-[0.99] active:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-black/10 dark:active:bg-neutral-800/60 dark:focus-visible:ring-violet-500/40'
        >
          <div className='flex min-w-0 items-start gap-3'>
            <div
              className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300'
              style={
                sectionThemeColors
                  ? {
                      backgroundColor: sectionThemeColors.accentBg,
                      color: sectionThemeColors.accentText,
                    }
                  : undefined
              }
            >
              <i className='bx bx-loader-circle text-lg' />
            </div>
            <div className='min-w-0'>
              <p className='text-sm font-medium text-stone-700 dark:text-neutral-100' style={titleStyle}>
                Streaming Animation
              </p>
              <p className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
                Pick the animation shown below a live assistant message while it streams.
              </p>
            </div>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <div className='hidden items-center gap-1 sm:flex'>
              <div
                className='h-4 w-4 rounded-md'
                style={{
                  backgroundColor: selectedStreamingLightColor,
                  boxShadow:
                    selectedStreamingLightColor.toLowerCase() === '#ffffff'
                      ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.12)'
                      : 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
                }}
                title='Light mode color'
              />
              <div
                className='h-4 w-4 rounded-md'
                style={{
                  backgroundColor: selectedStreamingDarkColor,
                  boxShadow:
                    selectedStreamingDarkColor.toLowerCase() === '#ffffff'
                      ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.12)'
                      : 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
                }}
                title='Dark mode color'
              />
            </div>
            <span
              className='hidden rounded-full bg-neutral-200/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-100 sm:inline-flex'
              style={badgeStyle}
            >
              {selectedStreamingAnimationName} · {selectedStreamingSpeed.toFixed(1)}×
            </span>
            <i
              className={`bx bx-chevron-down shrink-0 text-2xl text-neutral-500 dark:text-neutral-100 transition-transform duration-200 ${streamingExpanded ? 'rotate-180' : ''}`}
              style={bodyStyle}
            />
          </div>
        </button>

        {streamingExpanded && (
          <div className='space-y-3 px-3 pb-3 pt-1'>
            <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
              <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
                <SettingColorRow
                  label='Light Mode Color'
                  selectedColor={selectedStreamingLightColor}
                  onSelectColor={handleSelectStreamingLightColor}
                  colorPickerRef={streamingLightColorPickerRef}
                  sectionThemeColors={sectionThemeColors}
                />
              </div>
              <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
                <SettingColorRow
                  label='Dark Mode Color'
                  selectedColor={selectedStreamingDarkColor}
                  onSelectColor={handleSelectStreamingDarkColor}
                  colorPickerRef={streamingDarkColorPickerRef}
                  sectionThemeColors={sectionThemeColors}
                />
              </div>
            </div>

            <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
              <div className='space-y-2'>
                <div className='flex items-center justify-between gap-3'>
                  <span className='text-xs font-medium text-neutral-600 dark:text-neutral-100' style={bodyStyle}>
                    Speed
                  </span>
                  <span className='text-xs font-mono text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
                    {selectedStreamingSpeed.toFixed(1)}×
                  </span>
                </div>
                <div className='flex items-center gap-3'>
                  <span className='w-8 shrink-0 text-xs text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
                    0.5×
                  </span>
                  <input
                    type='range'
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={selectedStreamingSpeed}
                    onChange={e => handleStreamingSpeedChange(Number.parseFloat(e.target.value))}
                    className='h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-neutral-200 dark:bg-neutral-700'
                    style={
                      sectionThemeColors
                        ? {
                            backgroundColor: sectionThemeColors.codeBg,
                            accentColor: sectionThemeColors.primaryButtonBg,
                          }
                        : undefined
                    }
                  />
                  <span className='w-8 shrink-0 text-xs text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
                    2.0×
                  </span>
                  <button
                    type='button'
                    onClick={() => handleStreamingSpeedChange(1)}
                    className={`inline-flex shrink-0 items-center rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-100 transition-all duration-150 hover:bg-neutral-200 active:scale-[0.98] active:bg-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-700 dark:active:bg-neutral-700/90 dark:focus-visible:ring-violet-500/40 ${selectedStreamingSpeed === 1 ? 'invisible' : ''}`}
                    style={buttonStyle}
                    title='Reset speed'
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>

            <div className='space-y-2'>
              <span className='text-xs font-medium text-neutral-600 dark:text-neutral-100' style={bodyStyle}>
                Animation Style
              </span>
              <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
                {STREAMING_ANIMATIONS.map(animation => {
                  const isSelected = selectedStreamingAnimation === animation.id

                  return (
                    <button
                      key={animation.id}
                      type='button'
                      onClick={() => handleSelectStreamingAnimation(animation.id)}
                      className={`flex flex-col items-start gap-3 rounded-xl px-3 py-3 text-left text-neutral-700 dark:text-neutral-100 transition-all duration-150 hover:bg-white/80 active:scale-[0.98] active:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-900/40 dark:active:bg-neutral-900/50 dark:focus-visible:ring-violet-500/40 ${
                        isSelected
                          ? 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-100'
                          : 'bg-neutral-100/70 dark:bg-neutral-900/25'
                      }`}
                      style={isSelected ? selectedCardStyle : defaultCardStyle}
                      title={animation.name}
                    >
                      <div className='w-full overflow-hidden rounded-xl px-3 py-3' style={previewSurfaceStyle}>
                        <StreamingAnimationVisual
                          animationType={animation.id}
                          color={activeStreamingPreviewColor}
                          speed={selectedStreamingSpeed}
                          mode='preview'
                        />
                      </div>
                      <div className='space-y-1'>
                        <div className='text-sm font-medium' style={isSelected ? selectedTextStyle : itemTitleStyle}>
                          {animation.name}
                        </div>
                        <div className='text-xs' style={isSelected ? selectedTextStyle : itemMetaStyle}>
                          {animation.description}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const SendButtonLoadingAnimation: React.FC<{
  animationType: SendButtonAnimationType
  bgColor?: string
}> = ({ animationType, bgColor }) => {
  const style = bgColor ? ({ '--send-btn-bg': bgColor } as React.CSSProperties) : undefined

  switch (animationType) {
    case 'ellipsis-flow':
      return (
        <div className='send-btn-loading ellipsis-flow' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    case 'data-drift':
      return (
        <div className='send-btn-loading data-drift' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    case 'binary-swap':
      return (
        <div className='send-btn-loading binary-swap' style={style}>
          <span></span>
          <span></span>
        </div>
      )
    case 'pulse-freq':
      return (
        <div className='send-btn-loading pulse-freq' style={style}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    default:
      return <div className={`send-btn-loading ${animationType}`} style={style}></div>
  }
}

export const StreamingLoadingAnimation: React.FC<{
  animationType: StreamingAnimationType
  color?: string
  speed?: number
  className?: string
}> = ({ animationType, color = '#ef4444', speed = 1, className }) => (
  <StreamingAnimationVisual
    animationType={animationType}
    color={color}
    speed={speed}
    mode='live'
    className={className}
  />
)
