import { useState } from 'react'
import { ChevronDown, Zap } from 'lucide-react'
import { FAST_MODE_ANIMATIONS, saveFastModeAnimation, useFastModeAnimation } from '../../helpers/fastModeAnimationSettings'
import { FastModeAnimationBackground } from '../FastModeAnimation/FastModeAnimation'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import type { SettingsSectionThemeColors } from './settingsSectionTheme'

export const FastModeAnimationSettings = ({ sectionThemeColors: colors }: {
  sectionThemeColors?: SettingsSectionThemeColors | null
}) => {
  const [expanded, setExpanded] = useState(false)
  const selected = useFastModeAnimation()
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  return (
    <section className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10'
      style={colors ? { backgroundColor: colors.cardBg } : undefined}>
      <button type='button' onClick={() => setExpanded(value => !value)} aria-expanded={expanded}
        aria-controls='fast-mode-animation-options'
        className='flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline focus-visible:outline-2'>
        <span className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
          style={colors ? { backgroundColor: colors.accentBg, color: colors.accentText } : undefined}>
          <Zap size={18} />
        </span>
        <span className='flex-1'>
          <span className='block text-sm font-medium text-stone-700 dark:text-neutral-100'
            style={colors ? { color: colors.titleText } : undefined}>Fast mode animation</span>
          <span className='mt-0.5 block text-xs text-neutral-500 dark:text-neutral-300'
            style={colors ? { color: colors.bodyText } : undefined}>
            {FAST_MODE_ANIMATIONS.find(option => option.id === selected)?.name || 'None'} · Background behind the composer controls when Fast mode is on.
          </span>
        </span>
        <ChevronDown size={16} className={`mt-2 shrink-0 text-neutral-500 transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div id='fast-mode-animation-options' hidden={!expanded}>
        {expanded && <div className='px-3 pb-3'>
          <p className='mb-3 text-xs text-neutral-500 dark:text-neutral-300'
            style={colors ? { color: colors.bodyText } : undefined}>
            Hover or focus to preview. Default palettes match the design studies; custom themes supply the colors automatically. This does not enable the Fast service tier.
          </p>
          <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
            {[{ id: 'none' as const, name: 'None' }, ...FAST_MODE_ANIMATIONS].map(option => (
              <button key={option.id} type='button' aria-pressed={selected === option.id}
                onClick={() => saveFastModeAnimation(option.id)}
                className={`fm-option rounded-xl p-2 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${selected === option.id ? 'ring-2 ring-blue-400 dark:ring-blue-400' : ''} bg-white/70 text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200`}
                style={colors ? { backgroundColor: selected === option.id ? colors.primaryButtonBg : colors.innerCardBg,
                  color: selected === option.id ? colors.primaryButtonText : colors.bodyText } : undefined}>
                <span className='fm-preview relative mb-2 block h-10 overflow-hidden rounded-full bg-blue-100 dark:bg-slate-800'>
                  <FastModeAnimationBackground animation={option.id} dark={dark} theme={enabled ? theme : undefined} />
                </span>
                <span className='block'>{option.name}{selected === option.id ? ' ✓' : ''}</span>
              </button>
            ))}
          </div>
        </div>}
      </div>
    </section>
  )
}
