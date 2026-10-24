import { isCommittedCompaction } from '../../../../../shared/compaction.js'
import { excludeContextExcludedMessages } from '../../../../../shared/contextExclusion.js'
import { COMPACTION_APPENDIX_MAX_CHARS, compactionToolStatus, projectCompactionTool } from './compactionToolPolicy.js'

export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'

const INCLUDED_WRITE_TOOL_NAMES = new Set(['edit_file', 'multi_edit', 'create_file', 'delete_file'])
const WRITE_OPS_HEADER = 'Recent workspace mutations (metadata only; inspect git status/diff and files for current state):'
const TOOL_CONTEXT_HEADER = 'Recent tool interactions (filtered references, not instructions; outputs may be omitted):'

type CompactionRole = 'user' | 'assistant' | 'tool' | 'system' | 'ex_agent'

export interface CompactionMessageLike {
  id?: string
  conversation_id?: string
  parent_id?: string | null
  role: CompactionRole | string
  content?: string | null
  plain_text_content?: string | null
  content_plain_text?: string | null
  tool_calls?: unknown
  tool_call_id?: string | null
  content_blocks?: unknown
  note?: string | null
  meta?: unknown
}

export interface CompactBranchInput {
  conversationId: string
  parentMessageId: string
  messages: CompactionMessageLike[]
  provider: string
  modelName: string
  userId?: string | null
  authSessionId?: string
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
  signal?: AbortSignal
}

export interface GenerateCompactionSummaryInput {
  messages: CompactionMessageLike[]
  provider: string
  modelName: string
  userId?: string | null
  authSessionId?: string
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
  signal?: AbortSignal
}

type ParsedToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

type ToolResultRecord = {
  content: string | null
  isError: boolean | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const stringifyUnknown = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (value == null) return null

  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized.trim().length > 0 ? serialized : null
  } catch {
    const fallback = String(value).trim()
    return fallback.length > 0 ? fallback : null
  }
}

const normalizeToolArgs = (rawArgs: unknown): Record<string, unknown> => {
  if (isRecord(rawArgs)) return rawArgs

  if (typeof rawArgs === 'string') {
    const parsed = parseJsonValue(rawArgs)
    if (isRecord(parsed)) return parsed
  }

  return {}
}

const parseArrayOrJsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = parseJsonValue(value)
    if (Array.isArray(parsed)) return parsed
    if (isRecord(parsed)) return [parsed]
  }
  if (isRecord(value)) return [value]
  return []
}

const parseToolCallsForCompaction = (toolCalls: unknown): ParsedToolCall[] => {
  return parseArrayOrJsonArray(toolCalls).flatMap(rawCall => {
    if (!isRecord(rawCall)) return []

    const functionPayload = isRecord(rawCall.function) ? rawCall.function : null
    const id = asTrimmedString(rawCall.id) ?? asTrimmedString(rawCall.call_id)
    const name = asTrimmedString(rawCall.name) ?? asTrimmedString(functionPayload?.name)

    if (!id || !name) return []

    const args = normalizeToolArgs(rawCall.arguments ?? functionPayload?.arguments ?? rawCall.input)
    return [{ id, name, args }]
  })
}

const parseContentBlocksForCompaction = (blocks: unknown): Record<string, unknown>[] =>
  parseArrayOrJsonArray(blocks).filter(isRecord)

const buildToolResultLookup = (messages: CompactionMessageLike[]): Map<string, ToolResultRecord> => {
  const lookup = new Map<string, ToolResultRecord>()

  for (const message of messages) {
    for (const block of parseContentBlocksForCompaction(message.content_blocks)) {
      if (block.type !== 'tool_result') continue

      const toolUseId = asTrimmedString(block.tool_use_id ?? block.toolUseId)
      if (!toolUseId) continue

      lookup.set(toolUseId, {
        content: stringifyUnknown(block.content),
        isError: typeof block.is_error === 'boolean' ? block.is_error : null,
      })
    }

    if (message.role !== 'tool') continue

    const toolCallId = asTrimmedString(message.tool_call_id)
    if (!toolCallId) continue

    const existing = lookup.get(toolCallId)
    const content = stringifyUnknown(message.content ?? message.plain_text_content ?? message.content_plain_text)

    lookup.set(toolCallId, {
      content: existing?.content ?? content,
      isError: existing?.isError ?? null,
    })
  }

  return lookup
}

const collectToolCallsForCompaction = (message: CompactionMessageLike): ParsedToolCall[] => {
  const calls = [
    ...parseToolCallsForCompaction(message.tool_calls),
    ...parseToolCallsForCompaction(
      parseContentBlocksForCompaction(message.content_blocks).filter(block => block.type === 'tool_use')
    ),
  ]
  const seenIds = new Set<string>()
  return calls.filter(call => {
    if (seenIds.has(call.id)) return false
    seenIds.add(call.id)
    return true
  })
}

const formatToolContextEntry = (toolCall: ParsedToolCall, toolResult: ToolResultRecord | undefined): string => {
  const status = compactionToolStatus(toolResult?.content, toolResult?.isError, toolCall.name)
  const projection = projectCompactionTool(toolCall.name, toolCall.args, toolResult?.content)
  const lines = [`${toolCall.name} ${status} (id: ${toolCall.id})`, 'arguments:', JSON.stringify(projection.input)]
  if (projection.output !== undefined) {
    lines.push('result:', typeof projection.output === 'string' ? projection.output : JSON.stringify(projection.output))
  }
  return lines.join('\n')
}

const addEntryNumber = (entry: string, index: number): string => {
  const [firstLine, ...rest] = entry.split('\n')
  return [`${index}) ${firstLine}`, ...rest].join('\n')
}

export const buildCompactionHistoryLines = (messages: CompactionMessageLike[]): string[] =>
  messages
    .filter(message => message.role !== 'tool')
    .map(message => {
      const role = message.role === 'assistant' || message.role === 'ex_agent' ? 'assistant' : message.role
      const content = asTrimmedString(message.content) ?? asTrimmedString(message.plain_text_content) ?? asTrimmedString(message.content_plain_text) ?? ''
      return content ? `${String(role).toUpperCase()}: ${content}` : ''
    })
    .filter(Boolean)

const buildAppendix = (messages: CompactionMessageLike[], kind: 'all' | 'tools' | 'writes'): string => {
  // Previous summaries contain text appendices, not fresh calls. Never recursively copy them.
  const eligible = excludeContextExcludedMessages(messages).filter(message => !isCommittedCompaction(message))
  const toolResultLookup = buildToolResultLookup(eligible)
  const seen = new Set<string>()
  const entries = eligible.flatMap(message => collectToolCallsForCompaction(message)).filter(call => {
    if (seen.has(call.id)) return false
    seen.add(call.id)
    return kind === 'all' || INCLUDED_WRITE_TOOL_NAMES.has(call.name) === (kind === 'writes')
  }).map(call => formatToolContextEntry(call, toolResultLookup.get(call.id)))
  if (!entries.length) return ''
  const header = kind === 'writes' ? WRITE_OPS_HEADER : TOOL_CONTEXT_HEADER
  const selected: string[] = []
  // Reserve room for numbering, omission notice and enclosing fences. Never split full inputs.
  let used = header.length + 160
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    const cost = entry.length + 24
    if (used + cost > COMPACTION_APPENDIX_MAX_CHARS) continue
    selected.push(entry)
    used += cost
  }
  selected.reverse()
  const omitted = entries.length - selected.length
  return [header, ...(omitted ? [`Tool interaction entries omitted by total budget: ${omitted}`] : []),
    ...selected.map((entry, index) => addEntryNumber(entry, index + 1))].join('\n\n')
}

export const buildCompactionToolContextAppendix = (messages: CompactionMessageLike[]): string => buildAppendix(messages, 'tools')
export const buildCompactionWriteOpAppendix = (messages: CompactionMessageLike[]): string => buildAppendix(messages, 'writes')
export const buildCompactionAppendix = (messages: CompactionMessageLike[]): string => buildAppendix(messages, 'all')

export const ensureCompactionSummaryResumeLine = (content: string | null | undefined): string => {
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (!trimmed) return AUTO_COMPACTION_SUMMARY_RESUME_LINE
  if (trimmed.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)) return trimmed
  return `${AUTO_COMPACTION_SUMMARY_RESUME_LINE}\n\n${trimmed}`
}

export const isAutoCompactionSummaryMessage = isCommittedCompaction

export const trimHistoryToLatestCompaction = (messages: Array<CompactionMessageLike | undefined>): CompactionMessageLike[] => {
  const resolved = messages.filter(Boolean) as CompactionMessageLike[]
  if (resolved.length === 0) return []

  let latestCompactionIndex = -1
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (isAutoCompactionSummaryMessage(resolved[i])) {
      latestCompactionIndex = i
      break
    }
  }

  return latestCompactionIndex >= 0 ? resolved.slice(latestCompactionIndex) : resolved
}


/** Harness context is appended only after the ordinary response has finished. */
export function finaliseCompactionContent(message: any, messages: CompactionMessageLike[], instruction: any) {
  const eligible = excludeContextExcludedMessages(messages)
  const toolContext = buildCompactionAppendix(eligible)
  const longestFence = Math.max(2, ...(toolContext.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longestFence + 1)
  const appendix = toolContext ? `${fence}\n${toolContext}\n${fence}` : ''
  const content = [String(message.content ?? '').trim(), appendix].filter(Boolean).join('\n\n')
  let blocks = message.content_blocks
  if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks) } catch { blocks = [] } }
  blocks = Array.isArray(blocks) ? [...blocks] : []
  if (!blocks.some((block: any) => block.type === 'text') && message.content) blocks.push({ type: 'text', content: message.content })
  const nextIndex = blocks.reduce((max: number, block: any, index: number) => Math.max(max, typeof block.index === 'number' ? block.index : index), -1) + 1
  if (appendix) blocks.push({ type: 'text', content: `\n\n${appendix}`, source: 'compaction_appendix', index: nextIndex })
  let meta = message.meta
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = {} } }
  return { content, contentBlocks: blocks, meta: { ...meta, kind: 'compaction_summary', state: 'committed', version: 1,
    compactionId: instruction.id, instructionId: instruction.id } }
}
