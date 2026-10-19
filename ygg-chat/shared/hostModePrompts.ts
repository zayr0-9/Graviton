export interface HostModePrompts {
  selectedChatPromptId: string
  chatPrompts: Array<{ id: string; name: string; prompt: string; createdAt?: string; updatedAt?: string }>
  agentModePromptOverride: string | null
  subagentModePromptOverride: string | null
}
export function validateHostModePrompts(input: unknown): HostModePrompts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid mode prompts')
  const value = input as Partial<HostModePrompts>
  const keys = ['selectedChatPromptId', 'chatPrompts', 'agentModePromptOverride', 'subagentModePromptOverride']
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown mode prompt field')
  const prompts = value.chatPrompts ?? []
  if (!Array.isArray(prompts) || prompts.length > 100) throw new Error('Too many mode prompts')
  const ids = new Set<string>()
  const chatPrompts = prompts.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 200 || ids.has(row.id) || row.id === 'default-chat-mode' ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || typeof row.prompt !== 'string' || row.prompt.length > 200000) throw new Error('Invalid mode prompt')
    ids.add(row.id)
    return { id: row.id, name: row.name, prompt: row.prompt,
      ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt.slice(0, 64) } : {}),
      ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt.slice(0, 64) } : {}) }
  })
  for (const key of ['agentModePromptOverride', 'subagentModePromptOverride'] as const)
    if (value[key] != null && (typeof value[key] !== 'string' || value[key]!.length > 200000)) throw new Error('Invalid mode override')
  const selectedChatPromptId = value.selectedChatPromptId ?? 'default-chat-mode'
  if (selectedChatPromptId !== 'default-chat-mode' && !ids.has(selectedChatPromptId)) throw new Error('Selected mode prompt missing')
  if (JSON.stringify(value).length > 2000000) throw new Error('Mode prompts exceed capacity')
  return { selectedChatPromptId, chatPrompts, agentModePromptOverride: value.agentModePromptOverride ?? null, subagentModePromptOverride: value.subagentModePromptOverride ?? null }
}
