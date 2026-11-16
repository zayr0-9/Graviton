import { Brain, Check, TriangleAlert, Wrench } from 'lucide-react'
import type React from 'react'

/** Custom-theme colors for hover-preview blocks; null keeps the Tailwind fallback. */
export interface HeimdallPreviewPalette {
  cardBg: string
  codeBg: string
  codeText: string
  badgeBg: string
  badgeText: string
  primaryText: string
  mutedText: string
  successBg: string
  successText: string
  errorBg: string
  errorText: string
}

export type HeimdallPreviewBlockKind = 'tool' | 'result' | 'error' | 'thinking'

const ICONS = { tool: Wrench, result: Check, error: TriangleAlert, thinking: Brain } as const

const FALLBACK_BADGE_CLASS: Record<HeimdallPreviewBlockKind, string> = {
  tool: 'bg-white text-stone-600 dark:bg-neutral-800 dark:text-neutral-300',
  thinking: 'bg-white text-stone-600 dark:bg-neutral-800 dark:text-neutral-300',
  result: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
}

const badgeStyle = (kind: HeimdallPreviewBlockKind, palette: HeimdallPreviewPalette): React.CSSProperties =>
  kind === 'result'
    ? { backgroundColor: palette.successBg, color: palette.successText }
    : kind === 'error'
      ? { backgroundColor: palette.errorBg, color: palette.errorText }
      : { backgroundColor: palette.badgeBg, color: palette.badgeText }

/**
 * Borderless tonal card for tool calls, tool results and thinking in Heimdall's hover
 * preview. Hierarchy comes from fill, a circular icon badge and text weight
 * (agent_design.md); colors come from existing custom-theme tokens when enabled.
 */
export function HeimdallPreviewBlock({
  kind,
  title,
  palette,
  children,
}: {
  kind: HeimdallPreviewBlockKind
  title: string
  palette: HeimdallPreviewPalette | null
  children?: React.ReactNode
}) {
  const Icon = ICONS[kind]
  return (
    <div
      className={`rounded-2xl p-2.5 ${palette ? '' : 'bg-stone-100/80 dark:bg-white/[0.05]'}`}
      style={palette ? { backgroundColor: palette.cardBg } : undefined}
    >
      <div className='flex min-w-0 items-center gap-2'>
        <span
          aria-hidden='true'
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${palette ? '' : FALLBACK_BADGE_CLASS[kind]}`}
          style={palette ? badgeStyle(kind, palette) : undefined}
        >
          <Icon size={13} strokeWidth={2.25} />
        </span>
        <span
          className={`min-w-0 truncate text-xs font-medium ${palette ? '' : 'text-stone-700 dark:text-neutral-200'}`}
          style={palette ? { color: palette.primaryText } : undefined}
        >
          {title}
        </span>
      </div>
      {children != null && <div className='mt-2'>{children}</div>}
    </div>
  )
}

export function HeimdallPreviewCode({ palette, children }: { palette: HeimdallPreviewPalette | null; children: React.ReactNode }) {
  return (
    <pre
      className={`max-h-28 overflow-auto no-scrollbar whitespace-pre-wrap break-words rounded-xl px-2.5 py-2 font-mono text-[11px] leading-relaxed ${
        palette ? '' : 'bg-white/70 text-stone-700 dark:bg-black/25 dark:text-neutral-300'
      }`}
      style={palette ? { backgroundColor: palette.codeBg, color: palette.codeText } : undefined}
    >
      {children}
    </pre>
  )
}

export function HeimdallPreviewMuted({ palette, children }: { palette: HeimdallPreviewPalette | null; children: React.ReactNode }) {
  return (
    <p
      className={`line-clamp-4 text-xs leading-relaxed ${palette ? '' : 'text-stone-500 dark:text-neutral-400'}`}
      style={palette ? { color: palette.mutedText } : undefined}
    >
      {children}
    </p>
  )
}
