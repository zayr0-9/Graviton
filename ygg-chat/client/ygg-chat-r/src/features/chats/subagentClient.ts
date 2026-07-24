import type { QueryClient } from '@tanstack/react-query'
import type { RootState } from '../../store/store'
import type { Model, OperationMode } from './chatTypes'
import { buildLocalApiUrl, getCachedLocalApiBase } from '../../utils/api'
import { getSubagentModePrompt } from '../../helpers/operationModePromptStorage'
import { normalizeSubagentModelName } from '../../helpers/subagentModelNames'
import {
  getSubagentEnabledTools,
  getSubagentMaxTurns,
  isOrchestratorEnabled,
  loadSubagentToolSettings,
} from '../../helpers/subagentToolSettings'
import { getAllTools } from './toolDefinitions'

const DEFAULT_SUBAGENT_MODEL = 'gpt-5.6-sol'
// If no event (or heartbeat) arrives for this long, treat the stream as stalled.
// Heartbeats are sent every 15s, so this tolerates ~4 missed frames.
const SUBAGENT_STREAM_IDLE_TIMEOUT_MS = 60_000

const normalizeProviderSlug = (providerName: string | null | undefined): string =>
  (providerName || '').toLowerCase().replace(/\s+/g, '')

export type SubagentInheritedProvider = 'openaichatgpt' | 'openrouter' | 'lmstudio' | 'zai' | 'bedrock'

const resolveInheritedSubagentProvider = (
  callerProviderName: string | null | undefined
): SubagentInheritedProvider | undefined => {
  const slug = normalizeProviderSlug(callerProviderName)
  if (slug === 'openaichatgpt' || slug === 'openai(chatgpt)') return 'openaichatgpt'
  if (slug === 'openrouter') return 'openrouter'
  if (slug === 'lmstudio') return 'lmstudio'
  if (slug === 'z.ai/glm' || slug === 'zai/glm' || slug === 'zai' || slug === 'z.ai' || slug === 'glm') return 'zai'
  if (
    slug === 'bedrock' ||
    slug === 'awsbedrock' ||
    slug === 'aws-bedrock' ||
    slug === 'amazonbedrock' ||
    slug === 'amazon-bedrock'
  )
    return 'bedrock'
  return undefined
}

type ModelsCacheEntry = {
  models?: Model[]
  default?: Model
  selected?: Model
}

const resolveModelFromCache = (
  queryClient: QueryClient | null | undefined,
  providerName: string | null | undefined
): string | null => {
  if (!queryClient || !providerName) return null
  const modelsData = queryClient.getQueryData<ModelsCacheEntry>(['models', providerName])
  const selected = modelsData?.selected
  const defaultModel = modelsData?.default
  return selected?.id || selected?.name || defaultModel?.id || defaultModel?.name || null
}

/**
 * Resolve the provider + model a subagent should use. Subagents run locally, so
 * an inherited OpenRouter selection is redirected to the default local provider.
 */
const resolveSubagentDefaults = (
  callerProviderName?: string | null,
  queryClient?: QueryClient | null
): { model: string; provider: string } => {
  const settings = loadSubagentToolSettings()
  const configuredProvider = settings.defaultProvider?.trim() || null
  const configuredModel = settings.defaultModel?.trim() || null
  const providerNameForResolution = configuredProvider || callerProviderName || null

  const resolvedProvider = resolveInheritedSubagentProvider(providerNameForResolution)
  const rawModel =
    configuredModel || resolveModelFromCache(queryClient, providerNameForResolution) || DEFAULT_SUBAGENT_MODEL
  const model = normalizeSubagentModelName(rawModel, providerNameForResolution) || rawModel

  // Local-only: OpenRouter (and any unresolved provider) fall back to the
  // default local ChatGPT provider + model.
  if (!resolvedProvider || resolvedProvider === 'openrouter') {
    return { provider: 'openaichatgpt', model: resolvedProvider === 'openrouter' ? DEFAULT_SUBAGENT_MODEL : model }
  }

  return { provider: resolvedProvider, model }
}

export const resolveSubagentSystemPrompt = (requestedSystemPrompt: unknown): string => {
  const customSystemPrompt = typeof requestedSystemPrompt === 'string' ? requestedSystemPrompt.trim() : ''
  const defaultSystemPrompt = getSubagentModePrompt().prompt.trim()
  return [defaultSystemPrompt, customSystemPrompt].filter(Boolean).join('\n\n')
}

/**
 * Names of the tools the subagent may use, as configured in Settings. Mirrors
 * the previous getSubagentToolDefinitions selection but sends names only; the
 * server resolves them to definitions. Always excludes `subagent` (no nesting).
 */
const getSubagentToolNames = (orchestratorMode: boolean, requestedTools: unknown): string[] => {
  if (!isOrchestratorEnabled()) return []

  const allTools = getAllTools()
  const excluded = new Set(['subagent'])
  const useRequested = orchestratorMode && Array.isArray(requestedTools) && requestedTools.length > 0
  const allowed = new Set(
    (useRequested ? (requestedTools as string[]) : getSubagentEnabledTools()).filter(name => !excluded.has(name))
  )
  const bypassEnabledCheck = useRequested

  return allTools
    .filter(tool => (bypassEnabledCheck ? true : tool.enabled) && allowed.has(tool.name) && !excluded.has(tool.name))
    .map(tool => tool.name)
}

// Abort registry keyed by the parent stream id, so the existing
// abortSubagentControllers(streamId) call in chatActions keeps working.
const subagentAbortControllersByStream = new Map<string, Set<AbortController>>()

export const registerSubagentAbortController = (streamId: string | null | undefined, controller: AbortController) => {
  if (!streamId) return () => {}
  let controllers = subagentAbortControllersByStream.get(streamId)
  if (!controllers) {
    controllers = new Set()
    subagentAbortControllersByStream.set(streamId, controllers)
  }
  controllers.add(controller)
  return () => {
    const set = subagentAbortControllersByStream.get(streamId)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) subagentAbortControllersByStream.delete(streamId)
  }
}

export const abortSubagentControllers = (streamId?: string | null) => {
  if (streamId) {
    const controllers = subagentAbortControllersByStream.get(streamId)
    if (controllers) {
      controllers.forEach(controller => controller.abort())
      subagentAbortControllersByStream.delete(streamId)
    }
    return
  }

  for (const controllers of subagentAbortControllersByStream.values()) {
    controllers.forEach(controller => controller.abort())
  }
  subagentAbortControllersByStream.clear()
}

export interface SubagentClientContext {
  conversationId: string
  parentMessageId: string
  toolCallId?: string | null
  /** Parent stream id — abort-registry key and server-side lineage. */
  streamId?: string | null
  rootPath: string | null
  operationMode: OperationMode
  callerProvider?: string | null
  queryClient?: QueryClient | null
  /** Optional: only used to read live auto-approve and stream-active state. */
  getState?: (() => RootState) | null
}

interface SubagentStreamEvent {
  type?: string
  part?: string
  delta?: string
  result?: string
  message?: any
  error?: string
}

const extractFinalText = (event: SubagentStreamEvent): string | null => {
  if (typeof event.result === 'string') return event.result
  if (typeof event.message === 'string') return event.message
  if (event.message && typeof event.message.content === 'string') return event.message.content
  return null
}

/**
 * Thin client for the local headless subagent engine. Builds the request from
 * tool-call args + renderer settings, streams the SSE response, and returns the
 * final text. All loop/retry/persistence/abort logic lives server-side.
 */
export const executeSubagentCall = async (toolCall: any, context: SubagentClientContext): Promise<string> => {
  const args = toolCall?.arguments || {}
  const {
    prompt,
    systemPrompt,
    temperature,
    orchestratorMode = false,
    tools: requestedTools,
    inheritAutoApprove = true,
  } = args

  if (!prompt) {
    throw new Error('Subagent requires a prompt')
  }

  const getState = context.getState ?? null
  const callerProvider = context.callerProvider ?? getState?.().chat.providerState.currentProvider ?? null
  const { provider, model } = resolveSubagentDefaults(callerProvider, context.queryClient)
  const autoApprove = inheritAutoApprove !== false && (getState?.().chat.toolAutoApprove ?? false)

  const requestBody = {
    conversationId: context.conversationId,
    parentMessageId: context.parentMessageId,
    toolCallId: typeof toolCall?.id === 'string' ? toolCall.id : null,
    streamId: context.streamId ?? null,
    prompt,
    systemPrompt: resolveSubagentSystemPrompt(systemPrompt),
    provider,
    modelName: model,
    tools: getSubagentToolNames(orchestratorMode, requestedTools),
    maxTurns: getSubagentMaxTurns(),
    temperature: typeof temperature === 'number' ? temperature : undefined,
    operationMode: context.operationMode,
    autoApprove,
    rootPath: context.rootPath,
    userId: null,
  }

  const streamId = context.streamId ?? null
  const controller = new AbortController()
  const unregister = registerSubagentAbortController(streamId, controller)

  // Belt-and-braces: if the parent stream was registered in Redux, honor its
  // active flag. Streams never registered (e.g. the background agent) are exempt
  // so they are not aborted before they start.
  const trackedAtStart = !!(getState && streamId && getState().chat.streaming.byId[streamId])
  const isStreamActive = () => !trackedAtStart || (getState!().chat.streaming.byId[streamId!]?.active ?? false)

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const resetIdleTimer = () => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, SUBAGENT_STREAM_IDLE_TIMEOUT_MS)
  }

  try {
    let response: Response
    try {
      response = await fetch(await buildLocalApiUrl('/headless/subagent/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(stalled ? 'Subagent stream stalled: no events for 60s' : 'Subagent aborted')
      }
      throw new Error(
        `Local server not available at ${getCachedLocalApiBase()}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Subagent request failed: HTTP ${response.status}: ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Subagent stream returned no body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let accumulatedText = ''
    let finalText: string | null = null
    let terminal: 'complete' | 'error' | null = null
    let errorMessage: string | null = null

    resetIdleTimer()

    while (true) {
      if (!isStreamActive()) {
        controller.abort()
        throw new Error('Subagent aborted')
      }

      const { done, value } = await reader.read()
      if (done) break
      resetIdleTimer()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue // skips heartbeat comment frames
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let event: SubagentStreamEvent
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event.type === 'chunk' && event.part === 'text' && typeof event.delta === 'string') {
          accumulatedText += event.delta
        } else if (event.type === 'complete') {
          terminal = 'complete'
          finalText = extractFinalText(event)
        } else if (event.type === 'error') {
          terminal = 'error'
          errorMessage = typeof event.error === 'string' && event.error ? event.error : 'Subagent failed'
        }
        // Other events (started, tool_execution, tool_loop, context_usage,
        // context_compaction, assistant_message_persisted) are ignored here.
      }
    }

    if (terminal === 'error') {
      throw new Error(errorMessage || 'Subagent failed')
    }
    if (terminal !== 'complete') {
      throw new Error('Subagent stream ended without a terminal event')
    }

    return (finalText ?? accumulatedText).trim() || 'Subagent returned empty response'
  } catch (error) {
    if (stalled) {
      throw new Error('Subagent stream stalled: no events for 60s')
    }
    if (controller.signal.aborted && !(error instanceof Error && error.message === 'Subagent aborted')) {
      throw new Error('Subagent aborted')
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearIdleTimer()
    unregister()
  }
}
