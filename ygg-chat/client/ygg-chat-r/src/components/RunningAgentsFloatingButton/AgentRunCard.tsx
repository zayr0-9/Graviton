import type { CSSProperties, ReactNode } from 'react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode, type CustomChatTheme, type ThemeColorPair } from '../ThemeManager/themeConfig'
import { AgentMessageTooltip } from './AgentMessageTooltip'

export interface AgentCardStatus { active: boolean; hasError: boolean; label: string }
export const agentStatusDotClass = (status: AgentCardStatus) =>
  status.hasError ? 'bg-rose-500' : status.active ? 'bg-emerald-500' : 'bg-neutral-400'
export const agentCardToneClass = (active: boolean) => active ? 'bg-orange-50 dark:bg-orange-900/20' : 'bg-black/[0.035] dark:bg-white/5'

type ThemeColors = CustomChatTheme['colors']
type ThemeColorKey = { [Key in keyof ThemeColors]: ThemeColors[Key] extends ThemeColorPair ? Key : never }[keyof ThemeColors]

export function useAgentCardTheme() {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (key: ThemeColorKey) => enabled ? getThemeModeColor(theme.colors[key], dark) : undefined
  return {
    color,
    mutedStyle: { color: color('toolJobsMutedText') },
    secondaryStyle: enabled ? { backgroundColor: color('settingsCustomThemesButtonBg'), color: color('settingsCustomThemesButtonText') } : undefined,
    panelStyle: enabled ? { backgroundColor: color('settingsCustomThemesInnerCardBg') } : undefined,
    cardStyle: (active: boolean) => ({ backgroundColor: color(active ? 'agentsGridStreamingCardBg' : 'agentsGridIdleCardBg') }),
    statusDotStyle: (status: AgentCardStatus) => ({ backgroundColor: color(status.hasError
      ? 'toolJobsProgressFailed' : status.active ? 'toolJobsProgressRunning' : 'toolJobsProgressCompleted') }),
  }
}

interface AgentRunCardProps {
  name: string
  identifier?: string
  status: AgentCardStatus
  detail?: string | null
  detailTitle?: string
  prompt?: string | null
  forkKey?: string
  onOpen?: () => void
  leading?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** Shared presentation; each owner supplies its own run identity, actions and transcript source. */
export function AgentRunCard({ name, identifier, status, detail, detailTitle, prompt, forkKey, onOpen,
  leading, actions, children, className = '', style }: AgentRunCardProps) {
  const { mutedStyle, cardStyle, statusDotStyle } = useAgentCardTheme()
  const label = identifier ? `${name} · ${identifier}` : name
  const title = <>
    <span className='min-w-0 flex-1 truncate text-sm font-semibold' title={name}>{name}</span>
    {identifier && <span className='shrink-0 text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{identifier}</span>}
  </>
  return (
    <section data-agent-fork-key={forkKey} aria-label={label}
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl ${agentCardToneClass(status.active)} ${className}`}
      style={{ ...cardStyle(status.active), ...style }}>
      <div className='flex w-full min-w-0 shrink-0 flex-col gap-1 px-3 py-2'>
        <div className='flex min-w-0 items-center gap-1'>
          {leading}
          {onOpen ? <button type='button' onClick={onOpen} aria-label={`Preview ${label}`}
            className='flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:hover:bg-white/5'>{title}</button>
            : <div className='flex min-w-0 flex-1 items-center gap-2'>{title}</div>}
          {actions}
        </div>
        <div className='flex min-w-0 items-center gap-2 text-xs'>
          <span className='flex shrink-0 items-center gap-2 whitespace-nowrap'>
            <span className={`h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(status)}`} style={statusDotStyle(status)} aria-hidden='true' />
            {status.label}
          </span>
          <span className='min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400' style={mutedStyle} title={detailTitle}>{detail}</span>
        </div>
      </div>
      {prompt && <div className='shrink-0 px-3 pb-1'>
        <AgentMessageTooltip text={prompt}>
          <p className='truncate text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{prompt}</p>
        </AgentMessageTooltip>
      </div>}
      {children}
    </section>
  )
}
