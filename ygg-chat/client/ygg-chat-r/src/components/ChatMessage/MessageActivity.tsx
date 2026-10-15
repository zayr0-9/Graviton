import type { ReactNode } from 'react'
import type { ContentBlock, HookRunRecord } from '../../features/chats/chatTypes'
import type { CustomChatTheme } from '../ThemeManager/themeConfig'
import { ContextInjectionCard } from './ContextInjectionCard'
import { HookActivityCard } from './HookActivityCard'
import { useActivityStepLabels } from '../../helpers/activityStepLabelsSettings'

export function MessageActivity({ messageId, blocks = [], hooks = [], toolOffset = 0, fontSizeOffset = 0, customTheme, customThemeEnabled, isDarkMode, onHookRunsUpdated, onHookRunsSettled }: {
  messageId: string
  blocks?: ContentBlock[]
  hooks?: HookRunRecord[]
  toolOffset?: number
  fontSizeOffset?: number
  customTheme?: CustomChatTheme
  customThemeEnabled?: boolean
  isDarkMode?: boolean
  onHookRunsUpdated?: (messageId: string, runs: HookRunRecord[]) => void
  onHookRunsSettled?: () => void
}) {
  const showStepLabels = useActivityStepLabels()
  const steps = new Map<string, number>()
  let step = toolOffset
  for (const block of blocks) if (block.type === 'tool_use') steps.set(block.id, ++step)
  const cards: ReactNode[] = []
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.type !== 'context_injection') continue
    const startIndex = index
    const entries = [block]
    while (blocks[index + 1]?.type === 'context_injection' &&
      (blocks[index + 1] as typeof block).tool_use_id === block.tool_use_id) entries.push(blocks[++index] as typeof block)
    const sourceStep = block.tool_use_id ? steps.get(block.tool_use_id) : undefined
    cards.push(<ContextInjectionCard key={`${messageId}-context-${startIndex}`} entries={entries} fontSizeOffset={fontSizeOffset}
      sourceLabel={showStepLabels && sourceStep ? `After step ${sourceStep}` : undefined} customTheme={customTheme}
      customThemeEnabled={customThemeEnabled} isDarkMode={isDarkMode} />)
  }
  if (hooks.length) cards.push(<HookActivityCard key={`${messageId}-hooks`} messageId={messageId} initialRuns={hooks}
    fontSizeOffset={fontSizeOffset} onRunsUpdated={runs => onHookRunsUpdated?.(messageId, runs)} onRunsSettled={onHookRunsSettled} />)
  return <>{cards}</>
}
