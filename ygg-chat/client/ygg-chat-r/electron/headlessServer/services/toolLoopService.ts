import type { HeadlessStreamEvent } from '../contracts/headlessApi.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import type {
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../providers/openRouterProvider.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
import { persistWithFallback, type ToolResultPersistencePolicy } from './toolResultPersistenceService.js'
import { sanitizeToolResultContentForModel } from '../providers/toolResultSanitizer.js'
import { formatProviderErrorForAssistant, type FormattedProviderError } from '../providers/providerErrorFormatter.js'
import { assertToolAllowedForOperationMode } from '../../../../../shared/operationModeToolPolicy.js'
import {
  extractOpenAIContextUsageFromBlocks,
  openAIModelContextLength,
  resolveOpenAIContinuationCompaction,
  type OpenAIContextUsage,
} from '../../../../../shared/contextUsage.js'

export interface ToolExecutionContext {
  conversationId: string
  messageId: string
  streamId?: string | null
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  timeoutMs?: number
}

export type ToolExecutor = (toolCall: ProviderToolCall, context: ToolExecutionContext) => Promise<any>

export type ToolLoopCompactor = (input: {
  conversationId: string
  parentMessageId: string
  messages: any[]
  provider: string
  modelName: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
}) => Promise<{ message: any }>

interface ToolLoopServiceDeps {
  messageRepo: MessageRepo
  providerRouter: ProviderRouter
  executeTool?: ToolExecutor
  maxTurns?: number
  persistencePolicy?: Partial<ToolResultPersistencePolicy>
  providerTurnTimeoutMs?: number
  compactBranch?: ToolLoopCompactor
}

export interface ToolLoopRunInput {
  provider: string
  operation?: 'send' | 'repeat' | 'branch' | 'edit-branch'
  modelName: string
  conversationId: string
  assistantParentId: string | null
  history: any[]
  userContent: string
  systemPrompt?: string | null
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  attachmentsBase64?: any[] | null
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  isElectron?: boolean
  imageConfig?: any
  reasoningConfig?: any
  serviceTier?: 'priority'
  promptCacheRetention?: 'in_memory' | '24h'
  tools?: ProviderToolDefinition[]
  streamId?: string | null
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  toolTimeoutMs?: number
  autoCompactionEnabled?: boolean
  contextLength?: number
  compactionThresholdPercent?: number
  compactionProvider?: string | null
  compactionModelName?: string | null
  compactionSystemPrompt?: string | null
}

export interface ToolLoopRunResult {
  finalAssistantMessage: any
  turnsUsed: number
  providerError?: FormattedProviderError
}

export class ProviderErrorAssistantResponse extends Error {
  readonly assistantMessage: any
  readonly providerError: FormattedProviderError
  readonly turnsUsed: number

  constructor(input: { assistantMessage: any; providerError: FormattedProviderError; turnsUsed: number }) {
    super(input.providerError.originalMessage)
    this.name = 'ProviderErrorAssistantResponse'
    this.assistantMessage = input.assistantMessage
    this.providerError = input.providerError
    this.turnsUsed = input.turnsUsed
  }
}

const DEFAULT_MAX_TURNS = 400
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 180_000

function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const boundedTimeoutMs = Math.max(1_000, timeoutMs)

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`))
    }, boundedTimeoutMs)

    task.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function parseJsonArray(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function approximateTokens(value: unknown): number {
  if (value == null) return 0
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    serialized = String(value)
  }
  return Math.ceil(serialized.length / 4)
}

function projectedReplayTokens(input: ToolLoopRunInput, history: any[]): number {
  return (
    approximateTokens(input.systemPrompt) +
    approximateTokens(input.conversationContext) +
    approximateTokens(input.projectContext) +
    history.reduce((total, message) => total + approximateTokens(message), 0)
  )
}

function usageFromMessage(message: any): OpenAIContextUsage | null {
  const direct = message?.context_usage
  if (direct && typeof direct === 'object' && direct.provider === 'openai') return direct as OpenAIContextUsage
  return extractOpenAIContextUsageFromBlocks(message?.content_blocks)
}

function getToolResultPersistedContent(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (Object.prototype.hasOwnProperty.call(result, 'persistedContent')) return result.persistedContent
  if (Object.prototype.hasOwnProperty.call(result, 'displayContent')) return result.displayContent
  return result
}

function getToolResultModelContent(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return getToolResultPersistedContent(result)
  if (Object.prototype.hasOwnProperty.call(result, 'modelContent')) return result.modelContent
  return getToolResultPersistedContent(result)
}

function toToolResultContent(result: any): string {
  const persistedContent = getToolResultPersistedContent(result)
  if (typeof persistedContent === 'string') return persistedContent
  try {
    return JSON.stringify(persistedContent)
  } catch {
    return String(persistedContent)
  }
}

function toModelToolResultContent(content: string, toolName?: string | null): string {
  const sanitized = sanitizeToolResultContentForModel(content, toolName ?? null)
  if (typeof sanitized === 'string') return sanitized
  try {
    return JSON.stringify(sanitized ?? null)
  } catch {
    return String(sanitized)
  }
}

function normalizeToolCall(raw: any): ProviderToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : null
  if (!id || !name) return null

  return {
    id,
    name,
    arguments: raw.arguments ?? {},
    status: raw.status ?? 'pending',
  }
}

function appendGeneratedBlocks(output: ProviderGenerateOutput): any[] {
  const blocks = Array.isArray(output.contentBlocks) ? [...output.contentBlocks] : []

  const hasTextBlock = blocks.some(block => block?.type === 'text')
  if (output.content && !hasTextBlock) {
    blocks.push({ type: 'text', content: output.content })
  }

  if (output.reasoning && !blocks.some(block => block?.type === 'thinking')) {
    blocks.unshift({ type: 'thinking', content: output.reasoning })
  }

  if (Array.isArray(output.toolCalls)) {
    for (const call of output.toolCalls) {
      if (!call?.id || !call?.name) continue
      const alreadyPresent = blocks.some(block => block?.type === 'tool_use' && block?.id === call.id)
      if (!alreadyPresent) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })
      }
    }
  }

  return blocks
}

/**
 * Phase 4: pending -> execute -> tool_result -> continue loop.
 */
export class ToolLoopService {
  private readonly messageRepo: MessageRepo
  private readonly providerRouter: ProviderRouter
  private readonly executeTool?: ToolExecutor
  private readonly maxTurns: number
  private readonly persistencePolicy?: Partial<ToolResultPersistencePolicy>
  private readonly providerTurnTimeoutMs: number
  private readonly compactBranch?: ToolLoopCompactor

  constructor(deps: ToolLoopServiceDeps) {
    this.messageRepo = deps.messageRepo
    this.providerRouter = deps.providerRouter
    this.executeTool = deps.executeTool
    this.maxTurns = Math.max(1, deps.maxTurns ?? DEFAULT_MAX_TURNS)
    this.persistencePolicy = deps.persistencePolicy
    this.providerTurnTimeoutMs = Math.max(5_000, deps.providerTurnTimeoutMs ?? DEFAULT_PROVIDER_TURN_TIMEOUT_MS)
    this.compactBranch = deps.compactBranch
  }

  async run(input: ToolLoopRunInput, emit: (event: HeadlessStreamEvent) => void): Promise<ToolLoopRunResult> {
    let currentParentId = input.assistantParentId
    let currentUserContent = input.userContent
    let history = [...(input.history || [])]
    let lastAssistantMessage: any = null
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      emit({
        type: 'tool_loop',
        status: 'turn_started',
        turn,
        maxTurns: this.maxTurns,
      })

      const providerRoute = normalizeProviderRoute(input.provider)
      const providerInput: ProviderGenerateInput = {
        modelName: input.modelName,
        systemPrompt: input.systemPrompt ?? null,
        history,
        userContent: currentUserContent,
        userId: input.userId ?? null,
        accessToken: input.accessToken ?? null,
        accountId: input.accountId ?? null,
        tools: input.tools,
        think: input.think,
        temperature: input.temperature,
        railwayTurn:
          providerRoute === 'openrouter' || providerRoute === 'openaichatgpt'
            ? {
                conversationId: input.conversationId,
                parentId: currentParentId,
                operation: input.operation,
                conversationContext: input.conversationContext ?? null,
                projectContext: input.projectContext ?? null,
                think: input.think,
                temperature: input.temperature,
                attachmentsBase64: turn === 1 ? (input.attachmentsBase64 ?? null) : null,
                retrigger: turn === 1 ? input.retrigger : false,
                executionMode: input.executionMode,
                isBranch: input.isBranch,
                storageMode: 'local',
                isElectron: input.isElectron ?? true,
                imageConfig: input.imageConfig,
                reasoningConfig: input.reasoningConfig,
                serviceTier: input.serviceTier,
                promptCacheRetention: input.promptCacheRetention,
              }
            : null,
      }

      let output: ProviderGenerateOutput
      let streamedTextDuringTurn = false
      let streamedReasoningDuringTurn = false
      try {
        output = await withTimeout(
          this.providerRouter.generate(input.provider, providerInput, event => {
            if (event?.type === 'chunk' && event.part === 'text' && typeof event.delta === 'string' && event.delta.length > 0) {
              streamedTextDuringTurn = true
            }
            if (
              event?.type === 'chunk' &&
              event.part === 'reasoning' &&
              typeof event.delta === 'string' &&
              event.delta.length > 0
            ) {
              streamedReasoningDuringTurn = true
            }
            emit(event)
          }),
          this.providerTurnTimeoutMs,
          `Provider turn ${turn}/${this.maxTurns}`
        )
      } catch (error) {
        const providerError = formatProviderErrorForAssistant(error, {
          provider: input.provider,
          modelName: input.modelName,
        })

        if (providerError) {
          const assistantMessage = this.messageRepo.createMessage({
            conversationId: input.conversationId,
            parentId: currentParentId,
            role: 'assistant',
            content: providerError.message,
            modelName: input.modelName,
            contentBlocks: [{ type: 'text', content: providerError.message }],
          })

          if (!streamedTextDuringTurn) {
            emit({ type: 'chunk', part: 'text', delta: providerError.message })
          }
          emit({ type: 'assistant_message_persisted', message: assistantMessage })
          throw new ProviderErrorAssistantResponse({ assistantMessage, providerError, turnsUsed: turn })
        }

        const message = error instanceof Error ? error.message : String(error)
        emit({ type: 'error', error: `Continuation generation failed on turn ${turn}/${this.maxTurns}: ${message}` })
        throw error
      }

      if (output.contextUsage) {
        emit({ type: 'context_usage', usage: output.contextUsage })
      }
      if (output.reasoning && !streamedReasoningDuringTurn) {
        emit({ type: 'chunk', part: 'reasoning', delta: output.reasoning })
      }
      if (output.content && !streamedTextDuringTurn) {
        emit({ type: 'chunk', part: 'text', delta: output.content })
      }

      const assistantToolCalls = Array.isArray(output.toolCalls)
        ? output.toolCalls.map(normalizeToolCall).filter((call): call is ProviderToolCall => Boolean(call))
        : []

      const assistantContentBlocks = appendGeneratedBlocks({
        ...output,
        toolCalls: assistantToolCalls,
      })

      const assistantMessage = this.messageRepo.createMessage({
        conversationId: input.conversationId,
        parentId: currentParentId,
        role: 'assistant',
        content: output.content || '',
        modelName: input.modelName,
        toolCalls: assistantToolCalls,
        contentBlocks: assistantContentBlocks,
        contextUsage: output.contextUsage,
      })

      lastAssistantMessage = assistantMessage
      history.push(assistantMessage)
      const assistantHistoryIndex = history.length - 1
      emit({ type: 'assistant_message_persisted', message: assistantMessage })

      if (!assistantToolCalls.length) {
        emit({
          type: 'tool_loop',
          status: 'turn_completed',
          turn,
          maxTurns: this.maxTurns,
          continued: false,
        })

        return {
          finalAssistantMessage: assistantMessage,
          turnsUsed: turn,
        }
      }

      if (!this.executeTool) {
        emit({
          type: 'tool_loop',
          status: 'turn_completed',
          turn,
          maxTurns: this.maxTurns,
          continued: false,
        })

        return {
          finalAssistantMessage: assistantMessage,
          turnsUsed: turn,
        }
      }

      const toolResultBlocks: any[] = []

      for (const toolCall of assistantToolCalls) {
        emit({ type: 'chunk', part: 'tool_call', toolCall })
        emit({
          type: 'tool_execution',
          status: 'started',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        })

        let toolResultContent = ''
        let modelToolResultContent: any = ''
        let toolError = false
        const startedAt = Date.now()

        try {
          const operationMode = input.operationMode ?? 'execute'
          assertToolAllowedForOperationMode(toolCall, operationMode)

          const result = await this.executeTool(toolCall, {
            conversationId: input.conversationId,
            messageId: assistantMessage.id,
            streamId: input.streamId ?? null,
            rootPath: input.rootPath ?? null,
            operationMode,
            timeoutMs: input.toolTimeoutMs,
          })

          toolResultContent = toToolResultContent(result)
          modelToolResultContent = getToolResultModelContent(result)
          toolError = false

          emit({
            type: 'tool_execution',
            status: 'completed',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            durationMs: Math.max(0, Date.now() - startedAt),
          })
        } catch (error) {
          toolError = true
          toolResultContent = error instanceof Error ? error.message : String(error)
          modelToolResultContent = toolResultContent

          emit({
            type: 'tool_execution',
            status: 'failed',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: toolResultContent,
          })
        }

        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: toolResultContent,
          is_error: toolError,
        }

        toolResultBlocks.push(toolResultBlock)

        emit({
          type: 'chunk',
          part: 'tool_result',
          toolResult: {
            tool_use_id: toolCall.id,
            content: toolResultContent,
            is_error: toolError,
          },
        })

        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toModelToolResultContent(modelToolResultContent, toolCall.name),
        })
      }

      if (toolResultBlocks.length > 0) {
        const existingBlocks = parseJsonArray(assistantMessage.content_blocks)
        const updatedBlocks = [...existingBlocks, ...toolResultBlocks]

        const updatedToolCalls = assistantToolCalls.map(call => {
          const resultBlock = toolResultBlocks.find(block => block.tool_use_id === call.id)
          return {
            ...call,
            status: 'complete',
            result: resultBlock?.content,
          }
        })

        const inMemoryAssistant = {
          ...assistantMessage,
          content_blocks: JSON.stringify(updatedBlocks),
          tool_calls: JSON.stringify(updatedToolCalls),
        }

        const persistResult = await persistWithFallback({
          attemptPersist: async () => {
            const updated = this.messageRepo.updateAssistantToolState(assistantMessage.id, {
              contentBlocks: updatedBlocks,
              toolCalls: updatedToolCalls,
            })
            if (!updated) {
              throw new Error(`Assistant message missing during tool result persist: ${assistantMessage.id}`)
            }
            return updated
          },
          conversationId: input.conversationId,
          streamId: input.streamId ?? null,
          messageId: assistantMessage.id,
          contextLabel: 'tool_loop',
          policy: this.persistencePolicy,
        })

        const assistantForContinuation = persistResult.result ?? inMemoryAssistant
        lastAssistantMessage = assistantForContinuation
        history[assistantHistoryIndex] = assistantForContinuation
      }

      // Continue the loop even when all tool calls fail. Before issuing the next
      // provider request, compact at a quiescent boundary where every requested
      // tool has executed exactly once and its result is durable.
      currentParentId = assistantMessage.id
      currentUserContent = ''

      const reportedUsage = output.contextUsage ?? usageFromMessage(lastAssistantMessage)
      const compactionDecision = resolveOpenAIContinuationCompaction({
        providerName: input.provider,
        reportedUsage,
        projectedTokens: projectedReplayTokens(input, history),
        contextLength: input.contextLength ?? openAIModelContextLength(input.modelName),
        enabled: input.autoCompactionEnabled ?? true,
        thresholdPercent: input.compactionThresholdPercent,
      })

      if (compactionDecision.shouldCompact) {
        const eventDetails = {
          turn,
          reportedTokens: compactionDecision.reportedTokens,
          projectedTokens: compactionDecision.projectedTokens,
          effectiveTokens: compactionDecision.effectiveTokens,
          contextLength: compactionDecision.contextLength,
          thresholdPercent: compactionDecision.thresholdPercent,
          parentMessageId: assistantMessage.id,
        }
        emit({ type: 'context_compaction', status: 'threshold_reached', ...eventDetails })
        emit({ type: 'context_compaction', status: 'started', ...eventDetails })

        if (!this.compactBranch) {
          const error = 'Automatic context compaction is not configured; continuation paused before context overflow.'
          emit({ type: 'context_compaction', status: 'failed', ...eventDetails, error })
          throw new Error(error)
        }

        try {
          const compacted = await this.compactBranch({
            conversationId: input.conversationId,
            parentMessageId: assistantMessage.id,
            messages: history,
            provider: input.compactionProvider || input.provider,
            modelName: input.compactionModelName || input.modelName,
            userId: input.userId,
            accessToken: input.accessToken,
            accountId: input.accountId,
            systemPrompt: input.compactionSystemPrompt,
          })
          const summaryMessage = compacted?.message
          const validSummary =
            summaryMessage?.role === 'system' &&
            summaryMessage?.note === '__auto_compaction_summary__' &&
            String(summaryMessage?.parent_id ?? '') === String(assistantMessage.id)
          if (!validSummary) throw new Error('Compaction returned an invalid branch summary marker')

          history = [summaryMessage]
          currentParentId = summaryMessage.id
          emit({
            type: 'context_compaction',
            status: 'completed',
            ...eventDetails,
            parentMessageId: summaryMessage.id,
            summaryMessage,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: 'context_compaction', status: 'failed', ...eventDetails, error: message })
          throw new Error(`Automatic context compaction failed; continuation paused: ${message}`)
        }
      }

      emit({
        type: 'tool_loop',
        status: 'turn_completed',
        turn,
        maxTurns: this.maxTurns,
        continued: true,
      })
    }

    emit({
      type: 'tool_loop',
      status: 'max_turns_reached',
      turn: this.maxTurns,
      maxTurns: this.maxTurns,
      continued: false,
    })

    if (!lastAssistantMessage) {
      throw new Error('Tool loop ended without an assistant message')
    }

    throw new Error(
      `Tool loop reached max turns (${this.maxTurns}) without producing a final assistant response without tool calls`
    )
  }
}
