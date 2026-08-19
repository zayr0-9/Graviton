import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HeadlessOperationMode = 'plan' | 'execute'
export type HeadlessPlanModeVerbosity = 'concise' | 'normal' | 'detailed'

const DEFAULT_HEADLESS_INSTRUCTIONS = 'You are ChatGPT.'

const DEFAULT_CHAT_MODE_PROMPT_RELATIVE_PATH = 'src/features/chats/prompts/default_chat_mode.md'
const DEFAULT_AGENT_MODE_PROMPT_RELATIVE_PATH = 'src/features/chats/prompts/default_agent_mode.md'
const DEFAULT_SUBAGENT_MODE_PROMPT_RELATIVE_PATH = 'src/features/chats/prompts/default_subagent_mode.md'

let defaultChatModePrompt: string | null = null
let defaultAgentModePrompt: string | null = null
let defaultSubagentModePrompt: string | null = null

const appendPromptPart = (parts: string[], value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed) parts.push(trimmed)
}

const normalizePlanModeVerbosity = (value?: string | null): HeadlessPlanModeVerbosity => {
  return value === 'normal' || value === 'detailed' ? value : 'concise'
}

export function buildHeadlessPlanModeResponseStylePrompt(verbosity?: HeadlessPlanModeVerbosity | null): string {
  const resolvedVerbosity = normalizePlanModeVerbosity(verbosity)

  switch (resolvedVerbosity) {
    case 'detailed':
      return '## Plan Response Style\n\nUse detailed plans when helpful, but stay focused and avoid unrelated explanation.'
    case 'normal':
      return '## Plan Response Style\n\nUse a balanced plan with enough detail to implement the change. Avoid unnecessary verbosity.'
    case 'concise':
    default:
      return '## Plan Response Style\n\nUse short, concise plans. Prefer brief bullets and avoid unnecessary detail.'
  }
}

const candidatePromptPaths = (relativePath: string): string[] => {
  const paths = [
    // Source/test runtime: electron/headlessServer/services/*.ts -> repo root.
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
    // Bundled Electron main runtime: electron/main.mjs -> repo/app root.
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    // Local development fallback when the server is started from the package root.
    join(process.cwd(), relativePath),
  ]

  return [...new Set(paths)]
}

const readPromptFile = (relativePath: string): string => {
  const candidates = candidatePromptPaths(relativePath)

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf8').trim()
      }
    } catch {
      // Try the next candidate before warning below.
    }
  }

  console.warn(`[HeadlessSystemPrompt] Failed to load operation mode prompt from: ${candidates.join(', ')}`)
  return ''
}

export function getHeadlessOperationModePrompt(operationMode?: HeadlessOperationMode | null): string {
  if (operationMode === 'plan') {
    defaultChatModePrompt ??= readPromptFile(DEFAULT_CHAT_MODE_PROMPT_RELATIVE_PATH)
    return defaultChatModePrompt
  }

  defaultAgentModePrompt ??= readPromptFile(DEFAULT_AGENT_MODE_PROMPT_RELATIVE_PATH)
  return defaultAgentModePrompt
}

export function getHeadlessSubagentModePrompt(): string {
  defaultSubagentModePrompt ??= readPromptFile(DEFAULT_SUBAGENT_MODE_PROMPT_RELATIVE_PATH)
  return defaultSubagentModePrompt
}

export interface BuildHeadlessSystemPromptInput {
  operationMode?: HeadlessOperationMode | null
  includeOperationModePrompt?: boolean | null
  /** Selected baseline for this operation mode; blank/absent falls back to the bundled prompt. */
  operationModePrompt?: string | null
  requestPrompt?: string | null
  projectPrompt?: string | null
  conversationPrompt?: string | null
  planModeVerbosity?: HeadlessPlanModeVerbosity | null
}

export function buildHeadlessSystemPrompt({
  operationMode,
  includeOperationModePrompt = true,
  operationModePrompt,
  requestPrompt,
  projectPrompt,
  conversationPrompt,
  planModeVerbosity,
}: BuildHeadlessSystemPromptInput): string {
  const parts: string[] = []
  const resolvedOperationMode = operationMode ?? 'execute'

  if (includeOperationModePrompt !== false) {
    appendPromptPart(
      parts,
      typeof operationModePrompt === 'string' && operationModePrompt.trim()
        ? operationModePrompt
        : getHeadlessOperationModePrompt(resolvedOperationMode)
    )
    if (resolvedOperationMode === 'plan') {
      appendPromptPart(parts, buildHeadlessPlanModeResponseStylePrompt(planModeVerbosity))
    }
  }
  appendPromptPart(parts, requestPrompt)
  appendPromptPart(parts, projectPrompt)
  appendPromptPart(parts, conversationPrompt)

  return parts.join('\n\n') || DEFAULT_HEADLESS_INSTRUCTIONS
}
