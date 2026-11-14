import type { OperationMode } from '../../../../../shared/operationModeToolPolicy.js'
import type { ProviderToolCall } from '../providers/providerTypes.js'
import type { OperationModeControl } from './operationModeControl.js'
import type { ToolExecutor } from './toolLoopService.js'

export const SWITCH_MODE_TOOL_NAME = 'switch_mode'

export interface OperationModeSwitchResult {
  mode: 'chat' | 'agent'
  changed: boolean
  declined?: boolean
  message: string
}

/** Run-local mode switch for the model. Present only on runs with live mode control. */
export type OperationModeSwitcher = (toolCall: ProviderToolCall, mode: OperationMode) => Promise<OperationModeSwitchResult>

const label = (mode: OperationMode) => (mode === 'plan' ? 'chat' : 'agent')

/**
 * Chat -> Agent asks the user through the existing upgrade dialog. Agent -> Chat only
 * narrows what the model may do, so it applies at once. Both go through the run's
 * OperationModeControl, so the transcript notice and composer update exactly as for a
 * manual toggle.
 */
export function createOperationModeSwitcher(deps: {
  control: OperationModeControl
  requestUpgrade?: (toolCall: ProviderToolCall) => Promise<boolean>
  /** User inputs delivered so far; new input lets the model ask again after a decline. */
  userInputCount: () => number
}): OperationModeSwitcher {
  const { control } = deps
  let declinedAtInput: number | null = null
  return async (toolCall, mode) => {
    if (control.mode === mode) return { mode: label(mode), changed: false, message: `Already in ${label(mode)} mode.` }
    if (mode === 'plan') {
      control.change('plan', `switch_mode:${toolCall.id}`)
      return { mode: 'chat', changed: true, message: 'Switched to chat mode. Edits and other mutating tools are now blocked.' }
    }
    if (!deps.requestUpgrade) {
      throw new Error('Switching to agent mode needs user approval, which this run cannot ask for. Ask the user to switch to agent mode.')
    }
    if (declinedAtInput === deps.userInputCount()) {
      return { mode: 'chat', changed: false, declined: true,
        message: 'The user already declined switching to agent mode. Stay in chat mode; do not ask again unless the user requests it.' }
    }
    const approved = await deps.requestUpgrade(toolCall)
    if (approved && control.mode === 'execute') {
      declinedAtInput = null
      return { mode: 'agent', changed: true, message: 'The user approved. Switched to agent mode.' }
    }
    declinedAtInput = deps.userInputCount()
    return { mode: label(control.mode), changed: false, declined: true,
      message: 'The user chose to stay in chat mode. Continue read-only or explain what you would change; do not ask again unless the user requests it.' }
  }
}

function parseMode(raw: unknown): OperationMode {
  let args: any = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { throw new Error('switch_mode arguments must be valid JSON') }
  }
  const mode = typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : ''
  if (mode === 'chat' || mode === 'plan') return 'plan'
  if (mode === 'agent' || mode === 'execute') return 'execute'
  throw new Error('switch_mode requires mode "chat" or "agent"')
}

/** Keep the switch in-process, before ordinary background job dispatch. */
export function createOperationModeSwitchExecutor(leafExecutor: ToolExecutor): ToolExecutor {
  return async (toolCall, context) => {
    if (toolCall.name !== SWITCH_MODE_TOOL_NAME) return leafExecutor(toolCall, context)
    context.signal?.throwIfAborted()
    const mode = parseMode(toolCall.arguments)
    if (!context.switchOperationMode) throw new Error('switch_mode is only available in a main chat run.')
    return context.switchOperationMode(toolCall, mode)
  }
}
