/**
 * Provider contract shared by every headless provider (Codex/ChatGPT, LM Studio, Z.AI,
 * Bedrock, OpenRouter BYOK) and the tool loop.
 */
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import type { ContextUsage } from '../../../../../shared/contextUsage.js'

export interface ProviderToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, any>
}

export interface ProviderTurnContext {
  conversationId: string
  parentId?: string | null
  operation?: 'send' | 'repeat' | 'branch' | 'edit-branch'
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  attachmentsBase64?: Array<{ dataUrl: string; name?: string; type?: string; size?: number }> | null
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  isElectron?: boolean
  imageConfig?: any
  reasoningConfig?: any
  serviceTier?: 'priority'
  openaiHostedTools?: any
  promptCacheRetention?: 'in_memory' | '24h'
  runId?: string | null
  previousResponseId?: string | null
  allowCommentaryFallbackText?: boolean
}

export interface ProviderGenerateInput {
  modelName: string
  systemPrompt?: string | null
  history: any[]
  userContent: string
  userId?: string | null
  authSessionId?: string
  accessToken?: string | null
  accountId?: string | null
  tools?: ProviderToolDefinition[]
  think?: boolean
  temperature?: number
  /** Effective context-window limit for this generation. Used by ChatGPT diagnostics and loop compaction. */
  contextLength?: number
  turnContext?: ProviderTurnContext | null
  signal?: AbortSignal
}

export interface ProviderToolCall {
  id: string
  name: string
  arguments: any
  status?: 'pending' | 'executing' | 'complete'
  result?: string
}

export interface ProviderGenerateOutput {
  content: string
  reasoning?: string
  toolCalls?: ProviderToolCall[]
  contentBlocks?: any[]
  contextUsage?: ContextUsage
  raw?: any
}

/**
 * Whatever a streaming provider had already accumulated at the instant it threw.
 *
 * R1(a): a provider that fails after streaming 400 words must not lose the 400
 * words. Every streaming provider attaches this to the error it throws, as
 * `err.partialOutput`, and `toolLoopService` persists it as an ORDINARY assistant
 * row (no ErrorBlock) before the failure is reported.
 *
 * Field names are identical across every provider so consumers never special-case.
 * EMPTY FIELDS ARE OMITTED — a consumer can test presence without also testing
 * for `''` / `[]` — and if nothing at all was accumulated no `partialOutput` is
 * attached at all.
 */
export interface ProviderPartialOutput {
  content?: string
  contentBlocks?: any[]
  reasoning?: string
  toolCalls?: ProviderToolCall[]
}

/**
 * Attach `partial` to `error` as `error.partialOutput` and return the same error
 * so call sites read `throw attachPartialOutput(err, …)`.
 *
 * Merge semantics, innermost frame wins per field: the frame closest to the
 * stream owns the text it accumulated, while an outer frame (e.g. the Codex
 * provider, which is the only layer that knows how to build content blocks) can
 * still fill in fields the inner frame could not supply. Never overwrites.
 */
export function attachPartialOutput<E>(error: E, partial: ProviderPartialOutput | null | undefined): E {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  if (!partial) return error

  const target = error as any
  const existing = target.partialOutput && typeof target.partialOutput === 'object' ? (target.partialOutput as ProviderPartialOutput) : null
  const merged: ProviderPartialOutput = { ...(existing || {}) }

  if (!merged.content && partial.content) merged.content = partial.content
  if (!merged.reasoning && partial.reasoning) merged.reasoning = partial.reasoning
  if (!merged.toolCalls?.length && partial.toolCalls?.length) merged.toolCalls = partial.toolCalls
  if (!merged.contentBlocks?.length && partial.contentBlocks?.length) merged.contentBlocks = partial.contentBlocks

  if (Object.keys(merged).length === 0) return error

  try {
    target.partialOutput = merged
  } catch {
    // A frozen/exotic error object is not worth failing the failure path over.
  }
  return error
}

export type ProviderStreamEventHandler = (event: HeadlessStreamEvent) => void

export interface HeadlessProvider {
  name: string
  generate(input: ProviderGenerateInput, emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput>
}
