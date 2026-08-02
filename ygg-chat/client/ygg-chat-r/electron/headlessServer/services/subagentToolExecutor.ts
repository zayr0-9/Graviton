import type { HeadlessSubagentStreamRequest } from '../contracts/headlessApi.js'
import type { ProviderToolCall } from '../providers/openRouterProvider.js'
import type { ToolExecutionContext, ToolExecutor } from './toolLoopService.js'
import { getHeadlessSubagentModePrompt } from './headlessSystemPrompt.js'

const DEFAULT_SUBAGENT_MODEL = 'gpt-5.6-sol'

export interface ProgrammaticSubagentRunner {
  runForTool(request: HeadlessSubagentStreamRequest, signal: AbortSignal): Promise<string>
}

function parseArguments(toolCall: ProviderToolCall): Record<string, any> {
  if (typeof toolCall.arguments !== 'string') return toolCall.arguments ?? {}
  try {
    const parsed = JSON.parse(toolCall.arguments)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function buildSubagentRequest(toolCall: ProviderToolCall, context: ToolExecutionContext): HeadlessSubagentStreamRequest {
  const args = parseArguments(toolCall)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) throw new Error('Subagent requires a prompt')

  const inheritedProvider = context.provider || 'openaichatgpt'
  const provider = inheritedProvider === 'openrouter' ? 'openaichatgpt' : inheritedProvider
  const modelName = inheritedProvider === 'openrouter' ? DEFAULT_SUBAGENT_MODEL : context.modelName || DEFAULT_SUBAGENT_MODEL
  const useRequestedTools = args.orchestratorMode === true && Array.isArray(args.tools)
  const tools = useRequestedTools
    ? [...new Set([...args.tools, 'multi_call'].filter((name: unknown): name is string => typeof name === 'string' && name.trim() !== 'subagent'))]
    : undefined
  const requestedSystemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt.trim() : ''
  const systemPrompt = [getHeadlessSubagentModePrompt(), requestedSystemPrompt].filter(Boolean).join('\n\n')

  return {
    conversationId: context.conversationId,
    parentMessageId: context.messageId,
    toolCallId: toolCall.id,
    streamId: context.streamId ?? null,
    // ToolExecutionContext gains lineage at the parent loop boundary. Keep the
    // structural intersection compatible while that additive type lands.
    lineageId: (context as ToolExecutionContext & { lineageId?: string | null }).lineageId ?? null,
    prompt,
    systemPrompt: systemPrompt || null,
    provider,
    modelName,
    tools,
    temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
    reasoningEffort: context.subagentReasoningEffort,
    operationMode: context.operationMode ?? 'execute',
    autoApprove: args.inheritAutoApprove !== false && context.autoApprove !== false,
    rootPath: context.rootPath ?? null,
    userId: null,
    toolTimeoutMs: context.timeoutMs,
  }
}

/**
 * Intercept the model-visible `subagent` tool before ordinary calls enter the
 * ToolOrchestrator registry. Child runs receive only the leaf executor, which
 * preserves the no-nested-subagents invariant.
 */
export function createSubagentDispatchExecutor(deps: {
  leafExecutor: ToolExecutor
  subagentRunner: ProgrammaticSubagentRunner
}): ToolExecutor {
  return async (toolCall, context) => {
    if (toolCall.name !== 'subagent') return deps.leafExecutor(toolCall, context)

    const signal = context.signal ?? new AbortController().signal
    const request = buildSubagentRequest(toolCall, context)
    return deps.subagentRunner.runForTool(request, signal)
  }
}
