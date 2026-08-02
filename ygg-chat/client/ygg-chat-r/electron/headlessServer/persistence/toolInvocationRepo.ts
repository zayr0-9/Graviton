import { v4 as uuidv4 } from 'uuid'

export type ToolInvocationStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface ToolInvocationRow {
  id: string
  conversation_id: string
  lineage_id: string
  run_id: string | null
  parent_tool_invocation_id: string | null
  tool_call_id: string
  assistant_message_id: string
  tool_name: string
  status: ToolInvocationStatus
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface CreateToolInvocationInput {
  id?: string
  conversationId: string
  lineageId: string
  runId?: string | null
  parentToolInvocationId?: string | null
  toolCallId: string
  assistantMessageId: string
  toolName: string
  startedAt?: string
}

export interface FinishToolInvocationInput {
  status: Exclude<ToolInvocationStatus, 'running'>
  error?: string | null
  endedAt?: string
}

// Keep diagnostics useful but deliberately bounded; invocation rows are not a
// payload store and must never become a second home for tool args/results.
const MAX_ERROR_LENGTH = 512

const summarizeError = (error: unknown): string | null => {
  if (error == null) return null
  return String(error)
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, MAX_ERROR_LENGTH)
}

/** Durable, metadata-only ownership records. Tool arguments and results never enter this repo. */
export class ToolInvocationRepo {
  private readonly statements: any

  constructor(deps: { statements: any }) {
    this.statements = deps.statements
  }

  create(input: CreateToolInvocationInput): ToolInvocationRow {
    const id = input.id?.trim() || uuidv4()
    const startedAt = input.startedAt || new Date().toISOString()
    this.statements.insertToolInvocation.run(
      id,
      input.conversationId,
      input.lineageId,
      input.runId ?? null,
      input.parentToolInvocationId ?? null,
      input.toolCallId,
      input.assistantMessageId,
      input.toolName,
      startedAt,
      startedAt,
      startedAt
    )
    const row = this.get(id)
    if (!row) throw new Error(`Tool invocation was not persisted: ${id}`)
    return row
  }

  finish(id: string, input: FinishToolInvocationInput): ToolInvocationRow | null {
    const existing = this.get(id)
    if (!existing || existing.status !== 'running') return existing
    const endedAt = input.endedAt || new Date().toISOString()
    const startMs = new Date(existing.started_at).getTime()
    const endMs = new Date(endedAt).getTime()
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null
    const error = summarizeError(input.error)
    this.statements.finishToolInvocation.run(input.status, endedAt, durationMs, error, endedAt, id)
    return this.get(id)
  }

  get(id: string): ToolInvocationRow | null {
    return (this.statements.getToolInvocationById.get(id) as ToolInvocationRow | undefined) ?? null
  }

  listByLineage(lineageId: string): ToolInvocationRow[] {
    return this.statements.listToolInvocationsByLineage.all(lineageId) as ToolInvocationRow[]
  }
}
