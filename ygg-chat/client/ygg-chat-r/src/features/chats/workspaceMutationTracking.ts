import type { MessageId } from '../../../../../shared/types'
import type { Message } from './chatTypes'
import type { ClaudeFilePatch } from '../../../../../shared/claudeProvider'

// 'Edit' and 'Write' are Claude's native file tools.
export type WorkspaceMutationToolName = 'create_file' | 'edit_file' | 'delete_file' | 'multi_edit' | 'Edit' | 'Write'
export type WorkspaceMutationOperation = 'create' | 'edit' | 'delete'

export interface BranchFileMutation {
  key: string
  toolCallId: string
  toolName: WorkspaceMutationToolName
  operation: WorkspaceMutationOperation
  rawOperation?: string | null
  path: string
  messageId: MessageId
  timestamp?: string
  sequence: number
}

export interface BranchFileMutationSummary {
  path: string
  mutationCount: number
  latestMutation: BranchFileMutation
}

export interface BranchFileMutationData {
  history: BranchFileMutation[]
  latestByPath: BranchFileMutationSummary[]
}

type ParsedToolCall = {
  id: string
  name: WorkspaceMutationToolName
  args: Record<string, unknown>
  messageId: MessageId
  timestamp?: string
}

type ToolResultRecord = {
  content: unknown
  isError: boolean | null
  patch?: ClaudeFilePatch
}

type PendingMutation = Omit<BranchFileMutation, 'key' | 'sequence'>

const TRACKED_WRITE_TOOL_NAMES = new Set<WorkspaceMutationToolName>([
  'create_file',
  'edit_file',
  'delete_file',
  'multi_edit',
  'Edit',
  'Write',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value

  const trimmed = value.trim()
  if (!trimmed) return value

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeToolArgs = (value: unknown): Record<string, unknown> => {
  const parsed = parseMaybeJson(value)
  return isRecord(parsed) ? parsed : {}
}

const parseContentBlocks = (value: unknown): Record<string, unknown>[] => {
  const parsed = parseMaybeJson(value)

  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord)
  }

  if (isRecord(parsed)) {
    return [parsed]
  }

  return []
}

const toTrackedToolName = (value: unknown): WorkspaceMutationToolName | null => {
  const name = asNonEmptyString(value)
  if (!name || !TRACKED_WRITE_TOOL_NAMES.has(name as WorkspaceMutationToolName)) {
    return null
  }

  return name as WorkspaceMutationToolName
}

const addParsedToolCall = (
  calls: Map<string, ParsedToolCall>,
  rawId: unknown,
  rawName: unknown,
  rawArgs: unknown,
  messageId: MessageId,
  timestamp?: string
): void => {
  const id = asNonEmptyString(rawId)
  const name = toTrackedToolName(rawName)
  if (!id || !name || calls.has(id)) return

  calls.set(id, {
    id,
    name,
    args: normalizeToolArgs(rawArgs),
    messageId,
    timestamp,
  })
}

const parseTrackedToolCalls = (message: Message): ParsedToolCall[] => {
  const calls = new Map<string, ParsedToolCall>()
  const rawToolCalls = parseMaybeJson(message.tool_calls)

  const rawCallList: unknown[] = Array.isArray(rawToolCalls)
    ? rawToolCalls
    : isRecord(rawToolCalls)
      ? [rawToolCalls]
      : []

  for (const rawCall of rawCallList) {
    if (!isRecord(rawCall)) continue

    const functionPayload = isRecord(rawCall.function) ? rawCall.function : null
    addParsedToolCall(
      calls,
      rawCall.id,
      rawCall.name ?? functionPayload?.name,
      rawCall.arguments ?? functionPayload?.arguments ?? rawCall.input,
      message.id,
      message.created_at
    )
  }

  for (const block of parseContentBlocks(message.content_blocks)) {
    if (block.type !== 'tool_use') continue

    addParsedToolCall(calls, block.id, block.name, block.input, message.id, message.created_at)
  }

  return [...calls.values()]
}

const buildToolResultLookup = (messages: Message[]): Map<string, ToolResultRecord> => {
  const lookup = new Map<string, ToolResultRecord>()

  for (const message of messages) {
    for (const block of parseContentBlocks(message.content_blocks)) {
      if (block.type !== 'tool_result') continue

      const toolUseId = asNonEmptyString(block.tool_use_id ?? block.toolUseId)
      if (!toolUseId) continue

      const existing = lookup.get(toolUseId)
      lookup.set(toolUseId, {
        content: block.content !== undefined ? block.content : existing?.content ?? null,
        isError: typeof block.is_error === 'boolean' ? block.is_error : existing?.isError ?? null,
        patch: isRecord(block.patch) && typeof block.patch.filePath === 'string' ? block.patch as unknown as ClaudeFilePatch : existing?.patch,
      })
    }

    if (message.role !== 'tool') continue

    const toolCallId = asNonEmptyString(message.tool_call_id)
    if (!toolCallId) continue

    const existing = lookup.get(toolCallId)
    lookup.set(toolCallId, {
      content:
        message.content !== undefined
          ? message.content
          : message.content_plain_text !== undefined
            ? message.content_plain_text
            : existing?.content ?? null,
      isError: existing?.isError ?? null,
    })
  }

  return lookup
}

const resolveToolResultStatus = (toolResult: ToolResultRecord | undefined): { parsedContent: unknown; success: boolean } => {
  const parsedContent = parseMaybeJson(toolResult?.content)

  if (isRecord(parsedContent) && typeof parsedContent.success === 'boolean') {
    return {
      parsedContent,
      success: parsedContent.success,
    }
  }

  if (toolResult?.isError === false) {
    return {
      parsedContent,
      success: true,
    }
  }

  return {
    parsedContent,
    success: false,
  }
}

const createPendingMutation = (
  toolCall: ParsedToolCall,
  operation: WorkspaceMutationOperation,
  path: string,
  rawOperation?: string | null
): PendingMutation => ({
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  operation,
  rawOperation,
  path,
  messageId: toolCall.messageId,
  timestamp: toolCall.timestamp,
})

const extractSingleToolMutation = (
  toolCall: ParsedToolCall,
  toolResult: ToolResultRecord | undefined
): PendingMutation[] => {
  const { parsedContent, success } = resolveToolResultStatus(toolResult)
  if (!success) return []

  if (toolCall.name === 'Edit' || toolCall.name === 'Write') {
    const path = toolResult?.patch?.filePath ?? asNonEmptyString(toolCall.args.file_path)
    if (!path) return []
    // A Write without a patch (older rows) cannot say whether it created the file; edit is the safe label.
    return [createPendingMutation(toolCall, toolResult?.patch?.kind === 'create' ? 'create' : 'edit', path,
      toolCall.name === 'Edit' && toolCall.args.replace_all === true ? 'replace_all' : null)]
  }

  const resultPath = isRecord(parsedContent) ? asNonEmptyString(parsedContent.path) : null
  const argPath = asNonEmptyString(toolCall.args.path)
  const path = resultPath ?? argPath
  if (!path) return []

  if (toolCall.name === 'create_file') {
    return [createPendingMutation(toolCall, 'create', path)]
  }

  if (toolCall.name === 'delete_file') {
    return [createPendingMutation(toolCall, 'delete', path)]
  }

  if (toolCall.name === 'edit_file') {
    return [createPendingMutation(toolCall, 'edit', path, asNonEmptyString(toolCall.args.operation))]
  }

  return []
}

const extractMultiEditMutations = (
  toolCall: ParsedToolCall,
  toolResult: ToolResultRecord | undefined
): PendingMutation[] => {
  const { parsedContent, success } = resolveToolResultStatus(toolResult)
  const rawEdits = Array.isArray(toolCall.args.edits) ? toolCall.args.edits.filter(isRecord) : []
  const resultItems =
    isRecord(parsedContent) && Array.isArray(parsedContent.results) ? parsedContent.results.filter(isRecord) : []

  if (resultItems.length > 0) {
    return resultItems.flatMap((item, index) => {
      if (item.success !== true) return []

      const fallbackEdit = rawEdits[index]
      const path = asNonEmptyString(item.path) ?? asNonEmptyString(fallbackEdit?.path)
      if (!path) return []

      return [
        createPendingMutation(
          toolCall,
          'edit',
          path,
          asNonEmptyString(item.operation) ?? asNonEmptyString(fallbackEdit?.operation)
        ),
      ]
    })
  }

  if (!success || rawEdits.length === 0) return []

  return rawEdits.flatMap(edit => {
    const path = asNonEmptyString(edit.path)
    if (!path) return []

    return [createPendingMutation(toolCall, 'edit', path, asNonEmptyString(edit.operation))]
  })
}

export const extractBranchFileMutations = (messages: Message[]): BranchFileMutationData => {
  const toolResultLookup = buildToolResultLookup(messages)
  const history: BranchFileMutation[] = []
  const seenToolCallIds = new Set<string>()
  let sequence = 0

  for (const message of messages) {
    for (const toolCall of parseTrackedToolCalls(message)) {
      if (seenToolCallIds.has(toolCall.id)) continue
      seenToolCallIds.add(toolCall.id)

      const pendingMutations =
        toolCall.name === 'multi_edit'
          ? extractMultiEditMutations(toolCall, toolResultLookup.get(toolCall.id))
          : extractSingleToolMutation(toolCall, toolResultLookup.get(toolCall.id))

      for (const mutation of pendingMutations) {
        history.push({
          ...mutation,
          sequence,
          key: `${mutation.toolCallId}:${sequence}:${mutation.path}`,
        })
        sequence += 1
      }
    }
  }

  const latestByPathMap = new Map<string, BranchFileMutationSummary>()

  for (const mutation of history) {
    const existing = latestByPathMap.get(mutation.path)
    latestByPathMap.set(mutation.path, {
      path: mutation.path,
      mutationCount: (existing?.mutationCount ?? 0) + 1,
      latestMutation: mutation,
    })
  }

  const latestByPath = [...latestByPathMap.values()].sort(
    (a, b) => b.latestMutation.sequence - a.latestMutation.sequence
  )

  return {
    history,
    latestByPath,
  }
}
