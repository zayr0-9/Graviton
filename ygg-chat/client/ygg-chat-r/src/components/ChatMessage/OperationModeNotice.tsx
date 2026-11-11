import { ClipboardList, Code2, MessageCircle } from 'lucide-react'
import { RunSettingsNotice } from './RunSettingsNotice'

/** `claude_plan` is Claude Code's native plan mode, turned on by the Plan toggle or /plan. */
const MODES = {
  plan: { icon: MessageCircle, name: 'Chat', detail: 'Read-only' },
  execute: { icon: Code2, name: 'Agent', detail: 'Editing enabled' },
  claude_plan: { icon: ClipboardList, name: 'Plan', detail: 'Plans first, then asks to implement' },
} as const

export function OperationModeNotice({ mode, initial = false }: { mode: keyof typeof MODES; initial?: boolean }) {
  const { icon, name, detail } = MODES[mode]
  return <RunSettingsNotice icon={icon} label={initial ? `${name} mode` : `Switched to ${name}`} detail={detail} />
}
