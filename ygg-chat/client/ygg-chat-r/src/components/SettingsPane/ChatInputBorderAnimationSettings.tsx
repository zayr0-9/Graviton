import React, { useCallback, useMemo, useRef, useState } from 'react'
import type { SettingsSectionThemeColors } from './settingsSectionTheme'
import './ChatInputBorderAnimations.css'

export type ChatInputBorderAnimationType = 'none' | 'digital-breath' | 'data-wave' | 'orbit-rings' | 'shard-sweep'

export const CHAT_INPUT_BORDER_ANIMATION_STORAGE_KEY = 'chat:inputBorderAnimation'
export const CHAT_INPUT_BORDER_LIGHT_COLOR_STORAGE_KEY = 'chat:inputBorderLightColor'
export const CHAT_INPUT_BORDER_DARK_COLOR_STORAGE_KEY = 'chat:inputBorderDarkColor'

const CHAT_INPUT_BORDER_ANIMATIONS: {
  id: ChatInputBorderAnimationType
  name: string
  description: string
}[] = [
  {
    id: 'none',
    name: 'None',
    description: 'Use a static border with no animation.',
  },
  {
    id: 'digital-breath',
    name: 'Digital Breath',
    description: 'Softly expands and contracts with a subtle glow.',
  },
  {
    id: 'data-wave',
    name: 'Data Wave',
    description: 'A flowing wave sweeps around the full border ring.',
  },
  // {
  //   id: 'orbit-rings',
  //   name: 'Orbit Rings',
  //   description: 'Conic rings rotate with a sci-fi orbit look.',
  // },
  {
    id: 'shard-sweep',
    name: 'Shard Sweep',
    description: 'Angular streaks sweep the edge in layered passes.',
  },
]

const TAILWIND_COLORS = [
  { name: 'Emerald', value: '#10b981' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Red', value: '#ef4444' },
  { name: 'White', value: '#ffffff' },
]

export const getStoredChatInputBorderAnimation = (): ChatInputBorderAnimationType => {
  try {
    const stored = localStorage.getItem(CHAT_INPUT_BORDER_ANIMATION_STORAGE_KEY)
    if (stored && CHAT_INPUT_BORDER_ANIMATIONS.some(animation => animation.id === stored)) {
      return stored as ChatInputBorderAnimationType
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'digital-breath'
}

export const getStoredChatInputBorderLightColor = (): string => {
  try {
    const stored = localStorage.getItem(CHAT_INPUT_BORDER_LIGHT_COLOR_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // Ignore localStorage errors
  }
  return '#10b981'
}

export const getStoredChatInputBorderDarkColor = (): string => {
  try {
    const stored = localStorage.getItem(CHAT_INPUT_BORDER_DARK_COLOR_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // Ignore localStorage errors
  }
  return '#34d399'
}

export const saveChatInputBorderAnimation = (animation: ChatInputBorderAnimationType): void => {
  try {
    localStorage.setItem(CHAT_INPUT_BORDER_ANIMATION_STORAGE_KEY, animation)
    window.dispatchEvent(new CustomEvent('inputBorderAnimationChange', { detail: animation }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveChatInputBorderLightColor = (color: string): void => {
  try {
    localStorage.setItem(CHAT_INPUT_BORDER_LIGHT_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('inputBorderLightColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

export const saveChatInputBorderDarkColor = (color: string): void => {
  try {
    localStorage.setItem(CHAT_INPUT_BORDER_DARK_COLOR_STORAGE_KEY, color)
    window.dispatchEvent(new CustomEvent('inputBorderDarkColorChange', { detail: color }))
  } catch {
    // Ignore localStorage errors
  }
}

const SettingColorRow: React.FC<{
  label: string
  selectedColor: string
  onSelectColor: (color: string) => void
  colorPickerRef: React.RefObject<HTMLInputElement>
  sectionThemeColors?: SettingsSectionThemeColors | null
}> = ({ label, selectedColor, onSelectColor, colorPickerRef, sectionThemeColors = null }) => (
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

const ChatInputBorderPreview: React.FC<{
  animationType: ChatInputBorderAnimationType
  lightColor: string
  darkColor: string
}> = ({ animationType, lightColor, darkColor }) => {
  const previewClassName =
    animationType === 'none'
      ? 'chat-input-border-preview chat-input-border-preview-none'
      : `chat-input-border-preview chat-input-border-anim chat-input-border-${animationType}`

  return (
    <div
      className={previewClassName}
      style={
        {
          '--chat-input-border-light': lightColor,
          '--chat-input-border-dark': darkColor,
        } as React.CSSProperties
      }
    >
      <div className='chat-input-border-preview-inner'></div>
    </div>
  )
}

type ChatInputBorderAnimationSettingsProps = {
  sectionThemeColors?: SettingsSectionThemeColors | null
}

export const ChatInputBorderAnimationSettings: React.FC<ChatInputBorderAnimationSettingsProps> = ({
  sectionThemeColors = null,
}) => {
  const [expanded, setExpanded] = useState(false)
  const [selectedAnimation, setSelectedAnimation] = useState<ChatInputBorderAnimationType>(
    getStoredChatInputBorderAnimation
  )
  const [selectedLightColor, setSelectedLightColor] = useState<string>(getStoredChatInputBorderLightColor)
  const [selectedDarkColor, setSelectedDarkColor] = useState<string>(getStoredChatInputBorderDarkColor)
  const lightColorPickerRef = useRef<HTMLInputElement>(null)
  const darkColorPickerRef = useRef<HTMLInputElement>(null)

  const handleSelectAnimation = useCallback((animation: ChatInputBorderAnimationType) => {
    setSelectedAnimation(animation)
    saveChatInputBorderAnimation(animation)
  }, [])

  const handleSelectLightColor = useCallback((color: string) => {
    setSelectedLightColor(color)
    saveChatInputBorderLightColor(color)
  }, [])

  const handleSelectDarkColor = useCallback((color: string) => {
    setSelectedDarkColor(color)
    saveChatInputBorderDarkColor(color)
  }, [])

  const selectedAnimationName = useMemo(
    () => CHAT_INPUT_BORDER_ANIMATIONS.find(animation => animation.id === selectedAnimation)?.name ?? 'Digital Breath',
    [selectedAnimation]
  )

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
    <div className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10' style={sectionCardStyle}>
      <button
        type='button'
        onClick={() => setExpanded(prev => !prev)}
        className='group flex w-full items-start justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-150 hover:bg-neutral-100/80 active:scale-[0.99] active:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-black/10
        dark:active:bg-neutral-800/60 dark:focus-visible:ring-violet-500/40'
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
            <i className='bx bx-square-rounded text-lg' />
          </div>
          <div className='min-w-0'>
            <p className='text-sm font-medium text-stone-700 dark:text-neutral-100' style={titleStyle}>
              Chat Input Border Animation
            </p>
            <p className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100' style={bodyStyle}>
              Animate the composer border in chat mode while keeping the overall surface minimal.
            </p>
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <div className='hidden items-center gap-1 sm:flex'>
            <div
              className='h-4 w-4 rounded-md'
              style={{
                backgroundColor: selectedLightColor,
                boxShadow:
                  selectedLightColor.toLowerCase() === '#ffffff'
                    ? 'inset 0 0 0 1px rgba(15, 23, 42, 0.12)'
                    : 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
              }}
              title='Light mode color'
            />
            <div
              className='h-4 w-4 rounded-md'
              style={{
                backgroundColor: selectedDarkColor,
                boxShadow:
                  selectedDarkColor.toLowerCase() === '#ffffff'
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
            {selectedAnimationName}
          </span>
          <i
            className={`bx bx-chevron-down shrink-0 text-2xl text-neutral-500 dark:text-neutral-100 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            style={bodyStyle}
          />
        </div>
      </button>

      {expanded && (
        <div className='space-y-3 px-3 pb-3 pt-1'>
          <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
            <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
              <SettingColorRow
                label='Light Mode Color'
                selectedColor={selectedLightColor}
                onSelectColor={handleSelectLightColor}
                colorPickerRef={lightColorPickerRef}
                sectionThemeColors={sectionThemeColors}
              />
            </div>
            <div className='rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25' style={innerCardStyle}>
              <SettingColorRow
                label='Dark Mode Color'
                selectedColor={selectedDarkColor}
                onSelectColor={handleSelectDarkColor}
                colorPickerRef={darkColorPickerRef}
                sectionThemeColors={sectionThemeColors}
              />
            </div>
          </div>

          <div className='space-y-2'>
            <span className='text-xs font-medium text-neutral-600 dark:text-neutral-100' style={bodyStyle}>
              Animation Style
            </span>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              {CHAT_INPUT_BORDER_ANIMATIONS.map(animation => {
                const isSelected = selectedAnimation === animation.id

                return (
                  <button
                    key={animation.id}
                    type='button'
                    onClick={() => handleSelectAnimation(animation.id)}
                    className={`flex flex-col items-start gap-3 rounded-xl px-3 py-3 text-left text-neutral-700 dark:text-neutral-100 transition-all duration-150 hover:bg-white/80 active:scale-[0.98] active:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-900/40 dark:active:bg-neutral-900/50 dark:focus-visible:ring-violet-500/40 ${
                      isSelected
                        ? 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-100'
                        : 'bg-neutral-100/70 dark:bg-neutral-900/25'
                    }`}
                    style={isSelected ? selectedCardStyle : defaultCardStyle}
                    title={animation.name}
                  >
                    <div className='w-full overflow-hidden rounded-xl px-3 py-3' style={previewSurfaceStyle}>
                      <ChatInputBorderPreview
                        animationType={animation.id}
                        lightColor={selectedLightColor}
                        darkColor={selectedDarkColor}
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
  )
}
