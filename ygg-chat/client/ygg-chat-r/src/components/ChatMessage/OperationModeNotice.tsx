import { Code2, MessageCircle } from 'lucide-react'
import { RunSettingsNotice } from './RunSettingsNotice'

export function OperationModeNotice({ mode, initial = false }: { mode: 'plan' | 'execute'; initial?: boolean }) {
  const Icon = mode === 'plan' ? MessageCircle : Code2
  const name = mode === 'plan' ? 'Chat' : 'Agent'
  return <RunSettingsNotice icon={Icon} label={initial ? `${name} mode` : `Switched to ${name}`}
    detail={mode === 'plan' ? 'Read-only' : 'Editing enabled'} />
}
