import { v4 as uuidv4 } from 'uuid'

export type SubagentRunStatus = 'running' | 'completed' | 'error' | 'aborted'
export type SubagentMessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface SubagentMessageRow {
  id: string
  run_id: string
  role: string
  content: string
  thinking_block: string | null
  tool_calls: any
  tool_call_id: string | null
  content_blocks: any
  sequence: number
  created_at: string
}

export interface SubagentRunRow {
  id: string
  conversation_id: string
  parent_message_id: string
  tool_call_id: string | null
  prompt: string
  provider: string | null
  model_name: string | null
  system_prompt: string | null
  status: string
  final_response: string | null
  error: string | null
  turns_used: number
  tool_calls_used: number
  created_at: string
  updated_at: string
  messages?: SubagentMessageRow[]
}

export interface CreateSubagentRunInput {
  id?: string
  conversationId: string
  parentMessageId: string
  toolCallId?: string | null
  prompt: string
  provider?: string | null
  modelName?: string | null
  systemPrompt?: string | null
  status?: SubagentRunStatus
}

export interface UpdateSubagentRunInput {
  status?: SubagentRunStatus | null
  finalResponse?: string | null
  error?: string | null
  turnsUsed?: number | null
  toolCallsUsed?: number | null
}

export interface AppendSubagentMessageInput {
  id?: string
  role: SubagentMessageRole
  content?: string | null
  thinkingBlock?: string | null
  toolCalls?: any
  toolCallId?: string | null
  contentBlocks?: any
  sequence?: number
  createdAt?: string
}

const safeJsonParse = <T>(value: any, fallback: T): T => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export const normalizeSubagentMessageRow = (row: any): SubagentMessageRow => ({
  ...row,
  tool_calls: safeJsonParse(row.tool_calls, null),
  content_blocks: safeJsonParse(row.content_blocks, null),
})

export const normalizeSubagentRunRow = (row: any, messages: SubagentMessageRow[] = []): SubagentRunRow => ({
  ...row,
  turns_used: Number(row.turns_used || 0),
  tool_calls_used: Number(row.tool_calls_used || 0),
  messages,
})

/**
 * Repo over the subagent_runs / subagent_messages tables (schema + prepared
 * statements defined in electron/localServer.ts). Shared by the localServer
 * CRUD routes and the headless subagent engine so both write identically.
 */
export class SubagentRunRepo {
  private readonly statements: any

  constructor(deps: { statements: any }) {
    this.statements = deps.statements
  }

  createRun(input: CreateSubagentRunInput): SubagentRunRow {
    const runId = input.id?.trim() || uuidv4()
    const now = new Date().toISOString()
    this.statements.upsertSubagentRun.run(
      runId,
      input.conversationId,
      input.parentMessageId,
      input.toolCallId ?? null,
      input.prompt ?? '',
      input.provider ?? null,
      input.modelName ?? null,
      input.systemPrompt ?? null,
      input.status ?? 'running',
      null,
      null,
      0,
      0,
      now,
      now
    )
    return normalizeSubagentRunRow(this.statements.getSubagentRunById.get(runId), [])
  }

  updateRun(runId: string, patch: UpdateSubagentRunInput): SubagentRunRow | null {
    const now = new Date().toISOString()
    this.statements.updateSubagentRun.run(
      patch.status ?? null,
      patch.finalResponse ?? null,
      patch.error ?? null,
      typeof patch.turnsUsed === 'number' ? patch.turnsUsed : null,
      typeof patch.toolCallsUsed === 'number' ? patch.toolCallsUsed : null,
      now,
      runId
    )
    const row = this.statements.getSubagentRunById.get(runId)
    if (!row) return null
    return normalizeSubagentRunRow(row, this.getMessages(runId))
  }

  appendMessage(runId: string, input: AppendSubagentMessageInput): SubagentMessageRow {
    const messageId = input.id?.trim() || uuidv4()
    const nextSequence = this.statements.getNextSubagentMessageSequence.get(runId) as
      | { nextSequence: number }
      | undefined
    const resolvedSequence =
      typeof input.sequence === 'number' && Number.isFinite(input.sequence)
        ? input.sequence
        : nextSequence?.nextSequence ?? 0
    const createdAt = input.createdAt || new Date().toISOString()

    this.statements.insertSubagentMessage.run(
      messageId,
      runId,
      input.role,
      typeof input.content === 'string' ? input.content : input.content == null ? '' : JSON.stringify(input.content),
      input.thinkingBlock ?? null,
      typeof input.toolCalls === 'string' ? input.toolCalls : JSON.stringify(input.toolCalls ?? null),
      input.toolCallId ?? null,
      typeof input.contentBlocks === 'string' ? input.contentBlocks : JSON.stringify(input.contentBlocks ?? null),
      resolvedSequence,
      createdAt
    )

    return (
      this.findMessage(runId, messageId) ??
      normalizeSubagentMessageRow({
        id: messageId,
        run_id: runId,
        role: input.role,
        content: '',
        thinking_block: null,
        tool_calls: null,
        tool_call_id: null,
        content_blocks: null,
        sequence: resolvedSequence,
        created_at: createdAt,
      })
    )
  }

  /**
   * Merge tool-result blocks / tool-call state into an existing assistant row
   * without clobbering its content, thinking, sequence, or timestamp (mirrors
   * MessageRepo.updateAssistantToolState for the tree).
   */
  updateMessageToolState(
    runId: string,
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): SubagentMessageRow | null {
    const existing = this.findMessage(runId, messageId)
    if (!existing) return null

    this.statements.insertSubagentMessage.run(
      messageId,
      runId,
      existing.role,
      existing.content ?? '',
      existing.thinking_block ?? null,
      JSON.stringify(update.toolCalls ?? null),
      existing.tool_call_id ?? null,
      JSON.stringify(update.contentBlocks ?? null),
      existing.sequence,
      existing.created_at
    )

    return this.findMessage(runId, messageId)
  }

  getRunById(runId: string): SubagentRunRow | null {
    const row = this.statements.getSubagentRunById.get(runId)
    return row ? normalizeSubagentRunRow(row, []) : null
  }

  getRunWithMessages(runId: string): SubagentRunRow | null {
    const row = this.statements.getSubagentRunById.get(runId)
    if (!row) return null
    return normalizeSubagentRunRow(row, this.getMessages(runId))
  }

  getMessages(runId: string): SubagentMessageRow[] {
    return this.statements.getSubagentMessagesByRunId.all(runId).map(normalizeSubagentMessageRow)
  }

  listByConversation(conversationId: string): SubagentRunRow[] {
    return this.statements.getSubagentRunsByConversationId
      .all(conversationId)
      .map((run: any) => normalizeSubagentRunRow(run, this.getMessages(run.id)))
  }

  listByParentMessage(messageId: string): SubagentRunRow[] {
    return this.statements.getSubagentRunsByParentMessageId
      .all(messageId)
      .map((run: any) => normalizeSubagentRunRow(run, this.getMessages(run.id)))
  }

  private findMessage(runId: string, messageId: string): SubagentMessageRow | null {
    const messages = this.getMessages(runId)
    return messages.find(message => message.id === messageId) ?? null
  }
}
