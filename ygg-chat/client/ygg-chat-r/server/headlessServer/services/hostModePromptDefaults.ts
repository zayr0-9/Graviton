import type { HostModePrompts } from '../../../../../shared/hostModePrompts.js'
import { getHeadlessOperationModePrompt, getHeadlessSubagentModePrompt } from './headlessSystemPrompt.js'
export function resolveHostModePromptDefaults(settings: HostModePrompts): { operationModePrompt: string; subagentSystemPrompt: string } {
  const bundled = getHeadlessOperationModePrompt()
  const chatStart = bundled.indexOf('## Chat mode (plan) — conditional')
  const agentStart = bundled.indexOf('## Agent mode (execute) — conditional')
  const selected = settings.chatPrompts.find(prompt => prompt.id === settings.selectedChatPromptId)
  if (chatStart < 0 || agentStart <= chatStart) return { operationModePrompt: bundled, subagentSystemPrompt: settings.subagentModePromptOverride || getHeadlessSubagentModePrompt() }
  return {
    operationModePrompt: [bundled.slice(0, chatStart).trim(),
      '## Chat mode (plan) — applies only while Chat mode is active\n\n' + (selected?.prompt || bundled.slice(chatStart, agentStart).trim()),
      '## Agent mode (execute) — applies only while Agent mode is active\n\n' + (settings.agentModePromptOverride || bundled.slice(agentStart).trim())].join('\n\n'),
    subagentSystemPrompt: settings.subagentModePromptOverride || getHeadlessSubagentModePrompt(),
  }
}
