import { assertToolAllowedForOperationMode } from '../../../../../shared/operationModeToolPolicy.js'
import type { ProviderToolCall } from '../providers/openRouterProvider.js'
import type { ToolExecutionContext, ToolExecutor } from './toolLoopService.js'

const MAX_CALLS = 20
const MAX_CONCURRENCY = 4
const FORBIDDEN_NESTED_TOOLS = new Set(['multi_call', 'subagent'])

type NestedCall = { tool?: unknown; toolName?: unknown; args?: unknown }

type MultiCallResult = {
  tool: string
  ok: boolean
  data?: unknown
  error?: string
  skipped?: boolean
}

function parseArguments(toolCall: ProviderToolCall): Record<string, any> {
  if (typeof toolCall.arguments !== 'string') return toolCall.arguments ?? {}
  try {
    const parsed = JSON.parse(toolCall.arguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw new Error('multi_call arguments must be valid JSON')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function modelSafeData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('modelContent' in data)) return data
  const { modelContent: _modelContent, ...safeData } = data as Record<string, unknown>
  return safeData
}

function normalizeCalls(toolCall: ProviderToolCall): Array<{ tool: string; args: Record<string, unknown> }> {
  const args = parseArguments(toolCall)
  if (!Array.isArray(args.calls) || args.calls.length === 0) {
    throw new Error('multi_call requires at least one call')
  }
  if (args.calls.length > MAX_CALLS) {
    throw new Error(`multi_call supports at most ${MAX_CALLS} calls`)
  }

  return args.calls.map((call: NestedCall, index: number) => {
    const tool = typeof call?.tool === 'string' ? call.tool.trim() : typeof call?.toolName === 'string' ? call.toolName.trim() : ''
    if (!tool) throw new Error(`multi_call call ${index + 1} requires a tool name`)
    if (FORBIDDEN_NESTED_TOOLS.has(tool)) {
      throw new Error(`multi_call cannot invoke nested tool: ${tool}`)
    }
    const nestedArgs = call?.args == null ? {} : call.args
    if (typeof nestedArgs !== 'object' || Array.isArray(nestedArgs)) {
      throw new Error(`multi_call call ${index + 1} args must be an object`)
    }
    return { tool, args: nestedArgs as Record<string, unknown> }
  })
}

/** Execute a validated multi_call through the caller's policy-aware executor. */
export async function executeMultiCall(
  toolCall: ProviderToolCall,
  context: ToolExecutionContext,
  executeNested: ToolExecutor
): Promise<{ results: MultiCallResult[]; parallel: boolean; stopOnError: boolean }> {
  const args = parseArguments(toolCall)
  const calls = normalizeCalls(toolCall)
  const parallel = args.parallel === true
  const stopOnError = args.stopOnError !== false
  const concurrency = Math.max(1, Math.min(Number.isInteger(args.maxConcurrency) ? args.maxConcurrency : MAX_CONCURRENCY, MAX_CONCURRENCY))
  const results: MultiCallResult[] = new Array(calls.length)
  let nextIndex = 0
  let stopped = false

  const runOne = async (index: number) => {
    context.signal?.throwIfAborted()
    const call = calls[index]
    const nestedToolCall: ProviderToolCall = {
      id: `${toolCall.id}:${index + 1}`,
      name: call.tool,
      arguments: call.args,
    }

    try {
      assertToolAllowedForOperationMode(nestedToolCall, context.operationMode ?? 'execute')
      const data = await executeNested(nestedToolCall, context)
      results[index] = { tool: call.tool, ok: true, data: modelSafeData(data) }
    } catch (error) {
      if (context.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      results[index] = { tool: call.tool, ok: false, error: errorMessage(error) }
      if (stopOnError) stopped = true
    }
  }

  if (!parallel) {
    for (let index = 0; index < calls.length; index += 1) {
      if (stopped) {
        results[index] = { tool: calls[index].tool, ok: false, skipped: true, error: 'Skipped after an earlier call failed' }
        continue
      }
      await runOne(index)
    }
  } else {
    const worker = async () => {
      while (true) {
        if (stopped) return
        const index = nextIndex
        nextIndex += 1
        if (index >= calls.length) return
        await runOne(index)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, () => worker()))
    for (let index = 0; index < calls.length; index += 1) {
      results[index] ??= { tool: calls[index].tool, ok: false, skipped: true, error: 'Skipped after an earlier call failed' }
    }
  }

  return { results, parallel, stopOnError }
}

export function isMultiCall(toolCall: ProviderToolCall): boolean {
  return toolCall.name === 'multi_call'
}

/** Intercept multi_call before the ordinary ToolOrchestrator registry. */
export function createMultiCallDispatchExecutor(leafExecutor: ToolExecutor): ToolExecutor {
  return async (toolCall, context) => {
    if (!isMultiCall(toolCall)) return leafExecutor(toolCall, context)
    return executeMultiCall(toolCall, context, context.nestedExecutor ?? leafExecutor)
  }
}
