import React, { useMemo, useState } from 'react'
import { BookOpenText, ChevronRight } from 'lucide-react'
import {
  TEXT_DETAIL_CLASS,
  TEXT_LABEL_CLASS,
  TEXT_MICRO_CLASS,
} from './chatMessageShared'
import {
  getCustomChatThemeEnabled,
  getStoredCustomChatTheme,
  getThemeModeColor,
  useHtmlDarkMode,
  type CustomChatTheme,
} from '../ThemeManager/themeConfig'

/**
 * Visible marker for auto-loaded context (docs/claude_code_context_loading_rules.md
 * §11.3 decisions 6 and 7): instruction files, path-scoped rules, skills, and hook
 * output that the model received at this point of the transcript.
 *
 * Design (docs/agent_context/agent_design.md): a borderless glass surface. Hierarchy
 * comes from background tone, blur, whitespace and typography — no outline, no shadow.
 * Colours follow the custom chat theme (`contextCard*` keys) when it is enabled; the
 * Tailwind classes below are the disabled-theme fallback. Transitions name their
 * properties and run at the fast token (150ms).
 */

export interface ContextInjectionCardEntry {
  path: string
  label: string
  text: string
  reason: string
}

interface ContextInjectionCardProps {
  entries: ContextInjectionCardEntry[]
  /** `launch` = the per-branch instruction set row; `inline` = blocks beside a tool result or user message. */
  variant?: 'launch' | 'inline'
  fontSizeOffset?: number
  className?: string
  customTheme?: CustomChatTheme
  customThemeEnabled?: boolean
  isDarkMode?: boolean
}

const REASON_LABEL: Record<string, string> = {
  session_start: 'Instructions loaded',
  compact: 'Instructions reloaded after compaction',
  nested_traversal: 'Nested instructions loaded',
  path_glob_match: 'Path rule matched',
  include: 'Import loaded',
  skill: 'Skill loaded',
  hook: 'Hook context',
  memory: 'Memory loaded',
}

const REASON_ORDER = ['session_start', 'compact', 'nested_traversal', 'path_glob_match', 'include', 'skill', 'memory', 'hook']

function describeContextInjectionReason(reason: string): string {
  return REASON_LABEL[reason] ?? 'Context loaded'
}

function shortContextPath(entry: Pick<ContextInjectionCardEntry, 'path' | 'label'>): string {
  if (!entry.path) return entry.label
  const parts = entry.path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-3).join('/')
}

function summarizeReasons(entries: ContextInjectionCardEntry[]): string {
  const reasons = Array.from(new Set(entries.map(entry => entry.reason)))
  reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b))
  return reasons.map(describeContextInjectionReason).join(' · ')
}

interface CardPalette {
  bg?: string
  hoverBg?: string
  title?: string
  meta?: string
  path?: string
  muted?: string
  badgeBg?: string
  badgeText?: string
  codeBg?: string
  codeText?: string
}

const FAST_COLOR_TRANSITION = 'transition-[background-color,color] duration-150 ease-out'
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent dark:focus-visible:ring-orange-400/70'

export const ContextInjectionCard: React.FC<ContextInjectionCardProps> = ({
  entries,
  variant = 'inline',
  fontSizeOffset = 0,
  className,
  customTheme: customThemeProp,
  customThemeEnabled: customThemeEnabledProp,
  isDarkMode: isDarkModeProp,
}) => {
  const [expanded, setExpanded] = useState(false)
  const [openEntry, setOpenEntry] = useState<number | null>(null)
  const [hoveredRow, setHoveredRow] = useState<'header' | number | null>(null)
  const htmlDarkMode = useHtmlDarkMode()
  const isDarkMode = typeof isDarkModeProp === 'boolean' ? isDarkModeProp : htmlDarkMode

  // Same resolution order as ChatMessage: explicit props win, stored preference otherwise.
  const palette = useMemo<CardPalette>(() => {
    const enabled = typeof customThemeEnabledProp === 'boolean' ? customThemeEnabledProp : getCustomChatThemeEnabled()
    if (!enabled) return {}
    const theme = customThemeProp ?? getStoredCustomChatTheme()
    const pick = (pair: CustomChatTheme['colors']['contextCardBg']) => getThemeModeColor(pair, isDarkMode)
    return {
      bg: pick(theme.colors.contextCardBg),
      hoverBg: pick(theme.colors.contextCardHoverBg),
      title: pick(theme.colors.contextCardTitleText),
      meta: pick(theme.colors.contextCardMetaText),
      path: pick(theme.colors.contextCardPathText),
      muted: pick(theme.colors.contextCardMutedText),
      badgeBg: pick(theme.colors.contextCardBadgeBg),
      badgeText: pick(theme.colors.contextCardBadgeText),
      codeBg: pick(theme.colors.contextCardCodeBg),
      codeText: pick(theme.colors.contextCardCodeText),
    }
  }, [customThemeEnabledProp, customThemeProp, isDarkMode])
  const themed = Boolean(palette.bg)

  if (entries.length === 0) return null

  const title = summarizeReasons(entries)
  const fileCount = entries.filter(entry => entry.path).length
  const countLabel = fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : `${entries.length} item${entries.length === 1 ? '' : 's'}`
  const isLaunch = variant === 'launch'

  // Disabled-theme fallback classes. Inline styles from the palette win when themed.
  const surfaceClass = themed ? '' : 'bg-white/50 dark:bg-black/15'
  const headerHoverClass = themed ? '' : 'hover:bg-white/70 dark:hover:bg-white/5'
  const rowHoverClass = themed ? '' : 'hover:bg-white/60 dark:hover:bg-white/5'
  const titleClass = themed ? '' : 'text-violet-700 dark:text-violet-300'
  const metaClass = themed ? '' : 'text-violet-700/80 dark:text-violet-200/80'
  const pathClass = themed ? '' : 'text-stone-700 dark:text-stone-200'
  const mutedClass = themed ? '' : 'text-stone-500 dark:text-stone-400'
  const badgeClass = themed ? '' : 'bg-black/5 text-stone-600 dark:bg-white/10 dark:text-stone-300'
  const codeClass = themed ? '' : 'bg-black/5 text-stone-800 dark:bg-white/5 dark:text-stone-200'

  const color = (value?: string): React.CSSProperties | undefined => (themed && value ? { color: value } : undefined)
  const hoverFill = (key: 'header' | number): React.CSSProperties | undefined =>
    themed && hoveredRow === key ? { backgroundColor: palette.hoverBg } : undefined

  return (
    <div
      className={`rounded-2xl backdrop-blur-xl ${surfaceClass} ${isLaunch ? 'mx-2 my-2' : ''} ${className ?? ''}`}
      style={{
        ...(fontSizeOffset !== 0 ? { fontSize: `calc(1em + ${fontSizeOffset}px)` } : {}),
        ...(themed ? { backgroundColor: palette.bg } : {}),
      }}
      data-testid='context-injection-card'
    >
      <button
        type='button'
        onClick={() => setExpanded(value => !value)}
        onMouseEnter={() => setHoveredRow('header')}
        onMouseLeave={() => setHoveredRow(current => (current === 'header' ? null : current))}
        className={`flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left ${FAST_COLOR_TRANSITION} ${headerHoverClass} ${FOCUS_RING}`}
        style={hoverFill('header')}
        aria-expanded={expanded}
        aria-label={`${title}: ${countLabel}`}
      >
        <BookOpenText size={18} strokeWidth={2.25} className={`shrink-0 ${titleClass}`} style={color(palette.title)} />
        <span className={`font-mono ${TEXT_MICRO_CLASS} font-bold uppercase tracking-[0.12em] ${titleClass}`} style={color(palette.title)}>
          {title}
        </span>
        <span className={`${TEXT_DETAIL_CLASS} ${metaClass}`} style={color(palette.meta)}>
          {countLabel}
        </span>
        {!expanded && (
          <span className={`ml-1 min-w-0 flex-1 truncate font-mono text-[0.75em] ${mutedClass}`} style={color(palette.muted)}>
            {entries.map(shortContextPath).join(' · ')}
          </span>
        )}
        <ChevronRight
          size={18}
          strokeWidth={2.25}
          className={`ml-auto shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ${titleClass} ${expanded ? 'rotate-90' : ''}`}
          style={color(palette.title)}
        />
      </button>

      {expanded && (
        <ul className='flex flex-col gap-1 px-2 pb-2'>
          {entries.map((entry, index) => {
            const isOpen = openEntry === index
            return (
              <li key={`${entry.path || entry.label}-${index}`} className={TEXT_LABEL_CLASS}>
                <button
                  type='button'
                  onClick={() => setOpenEntry(isOpen ? null : index)}
                  onMouseEnter={() => setHoveredRow(index)}
                  onMouseLeave={() => setHoveredRow(current => (current === index ? null : current))}
                  className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left ${FAST_COLOR_TRANSITION} ${rowHoverClass} ${FOCUS_RING}`}
                  style={hoverFill(index)}
                  aria-expanded={isOpen}
                >
                  <ChevronRight
                    size={14}
                    strokeWidth={2.25}
                    className={`shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ${mutedClass} ${isOpen ? 'rotate-90' : ''}`}
                    style={color(palette.muted)}
                  />
                  <span className={`min-w-0 flex-1 truncate font-mono ${pathClass}`} style={color(palette.path)} title={entry.path || entry.label}>
                    {entry.path || entry.label}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-[2px] ${TEXT_MICRO_CLASS} uppercase tracking-wider ${badgeClass}`}
                    style={themed ? { backgroundColor: palette.badgeBg, color: palette.badgeText } : undefined}
                  >
                    {describeContextInjectionReason(entry.reason)}
                  </span>
                </button>
                {isOpen && (
                  <div className='ml-6 mt-1 mb-1'>
                    {entry.path && (
                      <p className={`mb-1 text-[0.85em] ${mutedClass}`} style={color(palette.muted)}>
                        {entry.label}
                      </p>
                    )}
                    <pre
                      className={`max-h-80 overflow-auto whitespace-pre-wrap rounded-xl p-3 text-[0.85em] leading-relaxed ${codeClass}`}
                      style={themed ? { backgroundColor: palette.codeBg, color: palette.codeText } : undefined}
                    >
                      {entry.text}
                    </pre>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default ContextInjectionCard
