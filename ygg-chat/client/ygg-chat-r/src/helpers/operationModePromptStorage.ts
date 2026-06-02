import defaultChatModePromptMarkdown from '../features/chats/prompts/default_chat_mode.md?raw'
import defaultAgentModePromptMarkdown from '../features/chats/prompts/default_agent_mode.md?raw'

const STORAGE_KEY = 'ygg_operation_mode_prompt_settings'

export const OPERATION_MODE_PROMPT_SETTINGS_CHANGE_EVENT = 'ygg-operation-mode-prompt-settings-change'
export const DEFAULT_CHAT_MODE_PROMPT_ID = 'default-chat-mode'
export const DEFAULT_AGENT_MODE_PROMPT_ID = 'default-agent-mode'

export interface OperationModePrompt {
  id: string
  name: string
  prompt: string
  createdAt?: string
  updatedAt?: string
}

export interface OperationModePromptSettings {
  selectedChatPromptId: string
  chatPrompts: OperationModePrompt[]
}

const defaultChatPrompt: OperationModePrompt = {
  id: DEFAULT_CHAT_MODE_PROMPT_ID,
  name: 'Default Chat Mode',
  prompt: defaultChatModePromptMarkdown.trim(),
}

const defaultAgentPrompt: OperationModePrompt = {
  id: DEFAULT_AGENT_MODE_PROMPT_ID,
  name: 'Default Agent Mode',
  prompt: defaultAgentModePromptMarkdown.trim(),
}

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `chat-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const normalizePrompt = (prompt: Partial<OperationModePrompt> | null | undefined): OperationModePrompt | null => {
  if (!prompt || typeof prompt !== 'object') return null
  const id = typeof prompt.id === 'string' ? prompt.id.trim() : ''
  const name = typeof prompt.name === 'string' ? prompt.name.trim() : ''
  const content = typeof prompt.prompt === 'string' ? prompt.prompt.trim() : ''
  if (!id || !name || !content || id === DEFAULT_CHAT_MODE_PROMPT_ID) return null
  return {
    id,
    name,
    prompt: content,
    createdAt: typeof prompt.createdAt === 'string' ? prompt.createdAt : undefined,
    updatedAt: typeof prompt.updatedAt === 'string' ? prompt.updatedAt : undefined,
  }
}

const normalizeSettings = (settings: Partial<OperationModePromptSettings> | null | undefined): OperationModePromptSettings => {
  const seen = new Set<string>()
  const chatPrompts = Array.isArray(settings?.chatPrompts)
    ? settings.chatPrompts.reduce<OperationModePrompt[]>((acc, rawPrompt) => {
        const prompt = normalizePrompt(rawPrompt)
        if (!prompt || seen.has(prompt.id)) return acc
        seen.add(prompt.id)
        acc.push(prompt)
        return acc
      }, [])
    : []

  const selectedCandidate = typeof settings?.selectedChatPromptId === 'string' ? settings.selectedChatPromptId : ''
  const selectedChatPromptId =
    selectedCandidate === DEFAULT_CHAT_MODE_PROMPT_ID || chatPrompts.some(prompt => prompt.id === selectedCandidate)
      ? selectedCandidate
      : DEFAULT_CHAT_MODE_PROMPT_ID

  return {
    selectedChatPromptId,
    chatPrompts,
  }
}

export function getDefaultChatModePrompt(): OperationModePrompt {
  return { ...defaultChatPrompt }
}

export function getDefaultAgentModePrompt(): OperationModePrompt {
  return { ...defaultAgentPrompt }
}

export function loadOperationModePromptSettings(): OperationModePromptSettings {
  try {
    if (typeof localStorage === 'undefined') {
      return normalizeSettings(null)
    }
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return normalizeSettings(null)
    return normalizeSettings(JSON.parse(stored) as Partial<OperationModePromptSettings>)
  } catch {
    return normalizeSettings(null)
  }
}

export function saveOperationModePromptSettings(settings: OperationModePromptSettings): OperationModePromptSettings {
  const normalized = normalizeSettings(settings)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(OPERATION_MODE_PROMPT_SETTINGS_CHANGE_EVENT, { detail: normalized }))
    }
  } catch (error) {
    console.error('[OperationModePromptStorage] Failed to save settings:', error)
  }
  return normalized
}

export function getActiveChatModePrompt(): OperationModePrompt {
  const settings = loadOperationModePromptSettings()
  if (settings.selectedChatPromptId === DEFAULT_CHAT_MODE_PROMPT_ID) {
    return getDefaultChatModePrompt()
  }
  return settings.chatPrompts.find(prompt => prompt.id === settings.selectedChatPromptId) ?? getDefaultChatModePrompt()
}

export function getAgentModePrompt(): OperationModePrompt {
  return getDefaultAgentModePrompt()
}

export function addChatModePrompt(name: string, prompt: string): OperationModePromptSettings {
  const settings = loadOperationModePromptSettings()
  const now = new Date().toISOString()
  const nextPrompt: OperationModePrompt = {
    id: makeId(),
    name: name.trim() || 'Custom Chat Mode Prompt',
    prompt: prompt.trim() || defaultChatPrompt.prompt,
    createdAt: now,
    updatedAt: now,
  }
  return saveOperationModePromptSettings({
    ...settings,
    selectedChatPromptId: nextPrompt.id,
    chatPrompts: [...settings.chatPrompts, nextPrompt],
  })
}

export function updateChatModePrompt(id: string, patch: Partial<Pick<OperationModePrompt, 'name' | 'prompt'>>): OperationModePromptSettings {
  if (id === DEFAULT_CHAT_MODE_PROMPT_ID) return loadOperationModePromptSettings()
  const settings = loadOperationModePromptSettings()
  const chatPrompts = settings.chatPrompts.map(prompt =>
    prompt.id === id
      ? {
          ...prompt,
          name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : prompt.name,
          prompt: typeof patch.prompt === 'string' && patch.prompt.trim() ? patch.prompt.trim() : prompt.prompt,
          updatedAt: new Date().toISOString(),
        }
      : prompt
  )
  return saveOperationModePromptSettings({ ...settings, chatPrompts })
}

export function deleteChatModePrompt(id: string): OperationModePromptSettings {
  if (id === DEFAULT_CHAT_MODE_PROMPT_ID) return loadOperationModePromptSettings()
  const settings = loadOperationModePromptSettings()
  const chatPrompts = settings.chatPrompts.filter(prompt => prompt.id !== id)
  const selectedChatPromptId =
    settings.selectedChatPromptId === id ? DEFAULT_CHAT_MODE_PROMPT_ID : settings.selectedChatPromptId
  return saveOperationModePromptSettings({ selectedChatPromptId, chatPrompts })
}

export function selectChatModePrompt(id: string): OperationModePromptSettings {
  const settings = loadOperationModePromptSettings()
  const selectedChatPromptId =
    id === DEFAULT_CHAT_MODE_PROMPT_ID || settings.chatPrompts.some(prompt => prompt.id === id)
      ? id
      : DEFAULT_CHAT_MODE_PROMPT_ID
  return saveOperationModePromptSettings({ ...settings, selectedChatPromptId })
}

export function resetChatModePromptSelectionToDefault(): OperationModePromptSettings {
  const settings = loadOperationModePromptSettings()
  return saveOperationModePromptSettings({ ...settings, selectedChatPromptId: DEFAULT_CHAT_MODE_PROMPT_ID })
}
