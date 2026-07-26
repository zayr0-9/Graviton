import { MessageRepo } from '../persistence/messageRepo.js'
import { ProviderRouter } from './providerRouter.js'

export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'

const DEFAULT_COMPACTION_SYSTEM_PROMPT =
  'You compact chat history. Return detailed markdown that preserves goals, hard requirements, key facts, decisions, pending tasks, and unresolved questions. Do not include tool protocol chatter, but include general context around changes made instead. Include full absolute paths of files touched/edited, and brief summary of what changed.'

const INCLUDED_WRITE_TOOL_NAMES = new Set(['edit_file', 'multi_edit', 'create_file', 'delete_file'])
const MAX_COMPACTION_WRITE_APPENDIX_CHARS = 40000
const MAX_EDIT_FILE_BEFORE_CHARS = 2200
const MAX_EDIT_FILE_AFTER_CHARS = 4200
const MAX_CREATE_FILE_CONTENT_CHARS = 1200
const MAX_TOOL_ERROR_CHARS = 280
const MAX_TOOL_CONTEXT_APPENDIX_CHARS = 40000
const MAX_TOOL_ARGUMENTS_CHARS = 4000
const MAX_TOOL_RESULT_CHARS = 8000
const MAX_SUBAGENT_RESULT_CHARS = 24000
const WRITE_OPS_HEADER = 'Recent workspace mutations (exact tool arguments/results preserved):'
const TOOL_CONTEXT_HEADER = 'Recent tool interactions (arguments/results preserved for context):'

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
}

export interface CompactBranchInput {
  conversationId: string
  parentMessageId: string
  messages: CompactionMessageLike[]
  provider: string
  modelName: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
}

export interface GenerateCompactionSummaryInput {
  messages: CompactionMessageLike[]
  provider: string
  modelName: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
}

interface CompactionServiceDeps {
  db: any
  statements: any
  providerRouter?: ProviderRouter
  tokenStore?: any
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

type ToolExecutionStatus = {
  label: 'success' | 'failed' | 'status unknown'
  errorText?: string | null
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

const truncateCompactionSnippet = (value: string | null | undefined, maxChars: number): string | null => {
  const normalized = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
  if (!normalized) return null
  if (normalized.length <= maxChars) return normalized

  const safeLimit = Math.max(0, maxChars - 18)
  const visible = normalized.slice(0, safeLimit).trimEnd()
  const omittedChars = Math.max(0, normalized.length - visible.length)
  return `${visible}\n...[truncated ${omittedChars} chars]`
}

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

const extractToolResultStatus = (toolResult: ToolResultRecord | undefined): ToolExecutionStatus => {
  if (!toolResult) return { label: 'status unknown' }

  const parsed = typeof toolResult.content === 'string' ? parseJsonValue(toolResult.content) : null
  if (isRecord(parsed) && typeof parsed.success === 'boolean') {
    if (parsed.success) return { label: 'success' }

    const errorText = asTrimmedString(parsed.message) ?? truncateCompactionSnippet(toolResult.content, MAX_TOOL_ERROR_CHARS)
    return { label: 'failed', errorText }
  }

  if (toolResult.isError === true) {
    return { label: 'failed', errorText: truncateCompactionSnippet(toolResult.content, MAX_TOOL_ERROR_CHARS) }
  }

  if (toolResult.isError === false) return { label: 'success' }

  const normalized = toolResult.content?.trim().toLowerCase() || ''
  if (normalized.startsWith('error') || normalized.includes('failed')) {
    return { label: 'failed', errorText: truncateCompactionSnippet(toolResult.content, MAX_TOOL_ERROR_CHARS) }
  }

  return toolResult.content ? { label: 'success' } : { label: 'status unknown', errorText: null }
}

const formatLineRange = (args: Record<string, unknown>): string | null => {
  const start = typeof args.approxStartLine === 'number' ? args.approxStartLine : null
  const end = typeof args.approxEndLine === 'number' ? args.approxEndLine : null

  if (start != null && end != null) return start === end ? String(start) : `${start}-${end}`
  if (start != null) return String(start)
  if (end != null) return String(end)
  return null
}

const appendEditFileDetails = (lines: string[], args: Record<string, unknown>): void => {
  const path = asTrimmedString(args.path)
  const operation = asTrimmedString(args.operation)
  const lineRange = formatLineRange(args)
  const beforeSearch = truncateCompactionSnippet(asTrimmedString(args.searchPattern), MAX_EDIT_FILE_BEFORE_CHARS)
  const afterLabel = operation === 'append' ? 'after/appended' : 'after/replacement'
  const afterValueSource =
    operation === 'append' ? asTrimmedString(args.content) : asTrimmedString(args.replacement) ?? asTrimmedString(args.content)
  const afterValue = truncateCompactionSnippet(afterValueSource, MAX_EDIT_FILE_AFTER_CHARS)

  if (path) lines.push(`path: ${path}`)
  if (operation) lines.push(`op: ${operation}`)
  if (lineRange) lines.push(`lines: ${lineRange}`)
  if (beforeSearch) {
    lines.push('before/search:')
    lines.push(beforeSearch)
  }
  if (afterValue) {
    lines.push(`${afterLabel}:`)
    lines.push(afterValue)
  }
}

const formatEditFileEntry = (toolCall: ParsedToolCall, status: ToolExecutionStatus): string => {
  const lines = [`edit_file ${status.label}`]
  appendEditFileDetails(lines, toolCall.args)
  if (status.errorText) {
    lines.push('error:')
    lines.push(status.errorText)
  }
  return lines.join('\n')
}

const formatMultiEditEntry = (toolCall: ParsedToolCall, status: ToolExecutionStatus): string | null => {
  const rawEdits = Array.isArray(toolCall.args.edits) ? toolCall.args.edits.filter(isRecord) : []
  if (rawEdits.length === 0) return null

  const lines = [`multi_edit ${status.label}`, `edits: ${rawEdits.length}`]

  rawEdits.forEach((editArgs, index) => {
    lines.push(`edit ${index + 1}:`)
    const detailLines: string[] = []
    appendEditFileDetails(detailLines, editArgs)
    if (detailLines.length === 0) {
      lines.push('  (no details)')
      return
    }
    lines.push(...detailLines.map(line => `  ${line}`))
  })

  if (status.errorText) {
    lines.push('error:')
    lines.push(status.errorText)
  }

  return lines.join('\n')
}

const formatCreateFileEntry = (toolCall: ParsedToolCall, status: ToolExecutionStatus): string => {
  const lines = [`create_file ${status.label}`]
  const path = asTrimmedString(toolCall.args.path)
  const content = truncateCompactionSnippet(asTrimmedString(toolCall.args.content) ?? '', MAX_CREATE_FILE_CONTENT_CHARS)

  if (path) lines.push(`path: ${path}`)
  lines.push('content:')
  lines.push(content ?? '(empty file)')
  if (status.errorText) {
    lines.push('error:')
    lines.push(status.errorText)
  }

  return lines.join('\n')
}

const formatDeleteFileEntry = (toolCall: ParsedToolCall, status: ToolExecutionStatus): string => {
  const lines = [`delete_file ${status.label}`]
  const path = asTrimmedString(toolCall.args.path)

  if (path) lines.push(`path: ${path}`)
  if (status.errorText) {
    lines.push('error:')
    lines.push(status.errorText)
  }

  return lines.join('\n')
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
  const status = extractToolResultStatus(toolResult)
  const lines = [`${toolCall.name} ${status.label}`]
  const args = truncateCompactionSnippet(stringifyUnknown(toolCall.args), MAX_TOOL_ARGUMENTS_CHARS)
  const resultLimit = toolCall.name === 'subagent' ? MAX_SUBAGENT_RESULT_CHARS : MAX_TOOL_RESULT_CHARS
  const result = truncateCompactionSnippet(toolResult?.content, resultLimit)

  lines.push('arguments:')
  lines.push(args ?? '{}')
  lines.push('result:')
  lines.push(result ?? '(result unavailable)')
  return lines.join('\n')
}

const formatWriteToolEntry = (toolCall: ParsedToolCall, toolResult: ToolResultRecord | undefined): string | null => {
  if (!INCLUDED_WRITE_TOOL_NAMES.has(toolCall.name)) return null

  const status = extractToolResultStatus(toolResult)

  if (toolCall.name === 'edit_file') {
    if (status.label === 'failed') return null
    return formatEditFileEntry(toolCall, status)
  }

  if (toolCall.name === 'multi_edit') {
    if (status.label === 'failed') return null
    return formatMultiEditEntry(toolCall, status)
  }

  if (toolCall.name === 'create_file') return formatCreateFileEntry(toolCall, status)
  if (toolCall.name === 'delete_file') return formatDeleteFileEntry(toolCall, status)
  return null
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

export const buildCompactionToolContextAppendix = (messages: CompactionMessageLike[]): string => {
  const toolResultLookup = buildToolResultLookup(messages)
  const formattedEntries = messages.flatMap(message =>
    collectToolCallsForCompaction(message)
      .filter(toolCall => !INCLUDED_WRITE_TOOL_NAMES.has(toolCall.name))
      .map(toolCall => formatToolContextEntry(toolCall, toolResultLookup.get(toolCall.id)))
  )

  if (formattedEntries.length === 0) return ''

  const selectedEntries: string[] = []
  let usedChars = TOOL_CONTEXT_HEADER.length
  for (let i = formattedEntries.length - 1; i >= 0; i--) {
    const entry = formattedEntries[i]
    const separatorChars = selectedEntries.length > 0 ? 2 : 0
    if (selectedEntries.length > 0 && usedChars + separatorChars + entry.length > MAX_TOOL_CONTEXT_APPENDIX_CHARS) continue
    selectedEntries.push(entry)
    usedChars += separatorChars + entry.length
    if (usedChars >= MAX_TOOL_CONTEXT_APPENDIX_CHARS) break
  }
  selectedEntries.reverse()
  if (selectedEntries.length === 0) selectedEntries.push(formattedEntries[formattedEntries.length - 1])

  const omittedCount = formattedEntries.length - selectedEntries.length
  const parts = [TOOL_CONTEXT_HEADER]
  if (omittedCount > 0) parts.push(`Older tool interaction entries omitted: ${omittedCount}`)
  parts.push(selectedEntries.map((entry, index) => addEntryNumber(entry, index + 1)).join('\n\n'))
  return parts.join('\n\n')
}

export const buildCompactionWriteOpAppendix = (messages: CompactionMessageLike[]): string => {
  const toolResultLookup = buildToolResultLookup(messages)
  const formattedEntries = messages.flatMap(message =>
    collectToolCallsForCompaction(message)
      .map(toolCall => formatWriteToolEntry(toolCall, toolResultLookup.get(toolCall.id)))
      .filter((entry): entry is string => Boolean(entry))
  )

  if (formattedEntries.length === 0) return ''

  const selectedEntries: string[] = []
  let usedChars = WRITE_OPS_HEADER.length

  for (let i = formattedEntries.length - 1; i >= 0; i--) {
    const entry = formattedEntries[i]
    const separatorChars = selectedEntries.length > 0 ? 2 : 0
    if (selectedEntries.length > 0 && usedChars + separatorChars + entry.length > MAX_COMPACTION_WRITE_APPENDIX_CHARS) {
      continue
    }

    selectedEntries.push(entry)
    usedChars += separatorChars + entry.length

    if (usedChars >= MAX_COMPACTION_WRITE_APPENDIX_CHARS) break
  }

  selectedEntries.reverse()

  if (selectedEntries.length === 0) {
    selectedEntries.push(formattedEntries[formattedEntries.length - 1])
  }

  const omittedCount = formattedEntries.length - selectedEntries.length
  const numberedEntries = selectedEntries.map((entry, index) => addEntryNumber(entry, index + 1))
  const parts = [WRITE_OPS_HEADER]

  if (omittedCount > 0) {
    parts.push(`Older workspace mutation entries omitted: ${omittedCount}`)
  }

  parts.push(numberedEntries.join('\n\n'))
  return parts.join('\n\n')
}

export const ensureCompactionSummaryResumeLine = (content: string | null | undefined): string => {
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (!trimmed) return AUTO_COMPACTION_SUMMARY_RESUME_LINE
  if (trimmed.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)) return trimmed
  return `${AUTO_COMPACTION_SUMMARY_RESUME_LINE}\n\n${trimmed}`
}

const isAutoCompactionSummaryMessage = (message: CompactionMessageLike | undefined | null): boolean =>
  Boolean(message && typeof message.note === 'string' && message.note === AUTO_COMPACTION_NOTE)

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

export class CompactionService {
  private readonly statements: any
  private readonly messageRepo: MessageRepo
  private readonly providerRouter: ProviderRouter

  constructor(deps: CompactionServiceDeps) {
    this.statements = deps.statements
    this.messageRepo = new MessageRepo({ db: deps.db, statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
  }

  /**
   * Compact an arbitrary message array into a single resume-line-prefixed summary
   * string. Does not touch any persistence, so it is reusable by callers that
   * store the summary outside the main tree (e.g. the subagent transcript).
   */
  async generateCompactionSummary(input: GenerateCompactionSummaryInput): Promise<string> {
    const compactableHistory = trimHistoryToLatestCompaction(Array.isArray(input.messages) ? input.messages : [])
    const historyLines = buildCompactionHistoryLines(compactableHistory)
    const toolContextAppendix = buildCompactionToolContextAppendix(compactableHistory)
    const writeOpAppendix = buildCompactionWriteOpAppendix(compactableHistory)

    if (historyLines.length === 0 && !toolContextAppendix && !writeOpAppendix) {
      throw new Error('No compactable branch context')
    }

    const historyText =
      historyLines.length > 0
        ? historyLines.join('\n\n')
        : '(No non-tool conversational text remained after filtering tool outputs.)'

    const compactionSystemPrompt = input.systemPrompt?.trim() || DEFAULT_COMPACTION_SYSTEM_PROMPT
    const compactionUserPrompt = [
      'Compact this branch context for continued conversation.',
      'Output sections:',
      '1) Objective',
      '2) Confirmed facts',
      '3) Decisions made',
      '4) Open tasks / next steps',
      '5) Risks / ambiguities',
      '',
      'Conversation history:',
      historyText,
      ...(toolContextAppendix ? ['', toolContextAppendix] : []),
    ].join('\n')

    const result = await this.providerRouter.generate(input.provider, {
      modelName: input.modelName,
      systemPrompt: compactionSystemPrompt,
      history: [],
      userContent: compactionUserPrompt,
      userId: input.userId ?? null,
      accessToken: input.accessToken ?? null,
      accountId: input.accountId ?? null,
      tools: [],
      temperature: 0.2,
    })

    const summaryText = String(result?.content ?? '').trim()
    if (!summaryText) {
      throw new Error('Compaction returned empty summary')
    }

    const fencedToolContextAppendix = toolContextAppendix ? `\`\`\`\n${toolContextAppendix}\n\`\`\`` : ''
    const fencedWriteOpAppendix = writeOpAppendix ? `\`\`\`\n${writeOpAppendix}\n\`\`\`` : ''
    return ensureCompactionSummaryResumeLine(
      [summaryText, fencedToolContextAppendix, fencedWriteOpAppendix]
        .filter(section => typeof section === 'string' && section.trim().length > 0)
        .join('\n\n')
    )
  }

  async compactBranch(input: CompactBranchInput): Promise<{ message: any }> {
    const conversation = this.statements.getConversationById.get(input.conversationId) as any
    if (!conversation) {
      throw new Error(`Conversation not found: ${input.conversationId}`)
    }

    const parentMessage = this.statements.getMessageById.get(input.parentMessageId) as any
    if (!parentMessage || String(parentMessage.conversation_id) !== String(input.conversationId)) {
      throw new Error(`Parent message not found in conversation: ${input.parentMessageId}`)
    }

    const persistedSummaryContent = await this.generateCompactionSummary({
      messages: input.messages,
      provider: input.provider,
      modelName: input.modelName,
      userId: input.userId ?? conversation.user_id ?? null,
      accessToken: input.accessToken,
      accountId: input.accountId,
      systemPrompt: input.systemPrompt,
    })

    const message = this.messageRepo.createMessage({
      conversationId: input.conversationId,
      parentId: input.parentMessageId,
      role: 'system',
      content: persistedSummaryContent,
      modelName: input.modelName,
      toolCalls: [],
      contentBlocks: [],
      note: AUTO_COMPACTION_NOTE,
    })

    return { message }
  }
}
