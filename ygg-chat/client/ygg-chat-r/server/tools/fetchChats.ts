import { createHash } from 'node:crypto'
import { isContextInjectionMessage } from '../../../../shared/contextInjection.js'

export interface FetchNotesArgs {
  action?: 'top_level' | 'siblings' | 'all'
  conversationId?: string
  branchPointAncestorId?: string
  limit?: number
  includeEmpty?: boolean
  includeContentPreview?: boolean
  previewChars?: number
}

export interface FetchChatsArgs {
  action?: 'list_chats' | 'get_chats' | 'search_chats' | 'search_messages' | 'search_notes' | 'get_notes' | 'read_branch'
  conversationId?: string
  conversationIds?: string[]
  userId?: string
  projectId?: string
  query?: string
  branchPointAncestorId?: string
  messageId?: string
  limit?: number
  includeEmpty?: boolean
  includeContentPreview?: boolean
  previewChars?: number
  offset?: number
  skip?: number
  responseMode?: 'metadata' | 'notes' | 'preview' | 'full'
  maxOutputChars?: number
  cursor?: string
  updatedAfter?: string
  updatedBefore?: string
  includeToolMessages?: boolean
  includeSyntheticMessages?: boolean
  messageLimit?: number
  messageSkip?: number
}

export interface ConversationPageInput {
  userId?: string
  projectId?: string
  updatedAfter?: string
  updatedBefore?: string
  query?: string
  limit: number
  skip: number
}

interface FetchChatsExecuteOptions {
  currentConversationId?: string | null
  listConversations: () => Array<Record<string, any>>
  listConversationsPage?: (input: ConversationPageInput) => Array<Record<string, any>>
  countTopLevelUserMessages?: (conversationId: string) => number
  getConversationById: (conversationId: string) => Record<string, any> | undefined
  searchConversations?: (input: { userId: string; projectId?: string; query: string; limit: number }) => Array<Record<string, any>>
  searchTopLevelMessages?: (input: { userId: string; projectId?: string; query: string; limit: number }) => Array<Record<string, any>>
  searchNotes?: (input: { userId: string; projectId?: string; query: string; limit: number }) => Array<Record<string, any>>
  listMessagesByConversationId: (conversationId: string) => Array<Record<string, any>>
  listTopLevelUserMessagesByConversationId?: (conversationId: string) => Array<Record<string, any>>
  getMessageById: (messageId: string) => Record<string, any> | undefined
}

interface BaseMessageItem {
  id: string
  conversation_id: string | null
  parent_id: string | null
  children_ids: string[]
  role: string
  created_at: string | null
  note: string | null
  note_color: string | null
  content: string | null
  plain_text_content: string | null
  content_preview?: string | null
}

interface ChatSummaryItem {
  id: string
  title: string | null
  created_at: string | null
  updated_at: string | null
  rootMessageCount?: number
  top_level_messages?: BaseMessageItem[]
  messageSkip?: number
  hasMoreMessages?: boolean
}

interface BranchReadItem extends BaseMessageItem {
  sequence_index: number
}

interface MessageSearchItem {
  conversation_id: string
  project_id: string | null
  storage_mode: 'cloud' | 'local'
  conversation_title: string | null
  message_id: string
  message_created_at: string
  conversation_updated_at: string | null
  content: string
  note: string | null
  match_type: 'fts' | 'fuzzy' | 'fallback'
  score: number
}

interface NoteSearchItem {
  conversation_id: string
  project_id: string | null
  storage_mode: 'cloud' | 'local'
  conversation_title: string | null
  message_id: string
  message_created_at: string
  note_updated_at: string | null
  note: string
  match_type: 'fts' | 'fuzzy' | 'vector'
  score: number
  lexical_score?: number
  vector_score?: number
  recency_score?: number
  vector_distance?: number | null
}

export interface FetchNotesResult {
  success: boolean
  error?: string
  conversationId?: string | null
  action?: 'top_level' | 'siblings' | 'all'
  branchPointAncestorId?: string
  siblingCount?: number
  totalCount?: number
  noteCount?: number
  notes?: BaseMessageItem[]
}

export interface FetchChatsResult {
  success: boolean
  error?: string
  action?: 'list_chats' | 'get_chats' | 'search_chats' | 'search_messages' | 'search_notes' | 'get_notes' | 'read_branch'
  currentConversationId?: string | null
  totalCount?: number
  chats?: ChatSummaryItem[]
  messageSearchResults?: MessageSearchItem[]
  noteSearchResults?: NoteSearchItem[]
  notes?: BaseMessageItem[]
  conversationId?: string | null
  requestedConversationIds?: string[]
  branchPointAncestorId?: string
  siblingCount?: number
  noteCount?: number
  messageId?: string
  skip?: number
  offset?: number
  returnedCount?: number
  branchMessages?: BranchReadItem[]
  hasMore?: boolean
  stoppedReason?: 'end_of_branch' | 'branch_point'
  nextBranchChildIds?: string[]
  responseMode?: FetchChatsArgs['responseMode']
  nextCursor?: string
  omittedCount?: number
  omittedChars?: number
  truncated?: boolean
  contentOffset?: number
  nextMessageSkip?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_PREVIEW_CHARS = 180
const MAX_PREVIEW_CHARS = 1200
const DEFAULT_BRANCH_OFFSET = 10
const MAX_BRANCH_OFFSET = 200
const DEFAULT_OUTPUT_CHARS = 20000
const MIN_OUTPUT_CHARS = 2000
const MAX_OUTPUT_CHARS = 200000

const safeText = (value: unknown): string => (typeof value === 'string' ? value : '')

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

const normalizeNullableText = (value: unknown): string | null => {
  const text = safeText(value)
  return text.length > 0 ? text : null
}

const normalizeNote = (value: unknown): string | null => {
  const text = safeText(value).trim()
  return text.length > 0 ? text : null
}

const normalizePreview = (value: unknown, maxChars: number): string | null => {
  const collapsed = safeText(value).replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, Math.max(0, maxChars - 3))}...`
}

const normalizeSearchText = (value: unknown): string =>
  safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const splitSearchTokens = (value: unknown): string[] => {
  const normalized = normalizeSearchText(value)
  if (!normalized) return []
  return Array.from(new Set(normalized.split(' ').filter(Boolean))).slice(0, 12)
}

const buildSearchSnippet = (rawText: unknown, rawQuery: string, maxLength: number = 220): string => {
  const text = safeText(rawText).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= maxLength) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = rawQuery.toLowerCase().trim()
  const matchIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1

  if (matchIndex === -1) {
    return `${text.slice(0, maxLength).trim()}...`
  }

  const halfWindow = Math.floor(maxLength / 2)
  const start = Math.max(0, matchIndex - halfWindow)
  const end = Math.min(text.length, start + maxLength)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

const calculateMessageSearchScore = (query: string, text: string, note: string | null): number => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return 0

  const combined = normalizeSearchText(`${note || ''} ${text || ''}`)
  if (!combined) return 0
  if (combined.includes(normalizedQuery)) return 2

  const queryTokens = splitSearchTokens(query)
  if (queryTokens.length === 0) return 0

  let matched = 0
  for (const token of queryTokens) {
    if (combined.includes(token)) matched += 1
  }

  return matched > 0 ? matched / queryTokens.length : 0
}

const parseTimestamp = (value: string | null): number => {
  if (!value) return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const sortByCreatedAtAsc = (a: { created_at: string | null }, b: { created_at: string | null }): number => {
  const aTime = parseTimestamp(a.created_at)
  const bTime = parseTimestamp(b.created_at)
  if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0
  if (!Number.isFinite(aTime)) return 1
  if (!Number.isFinite(bTime)) return -1
  return aTime - bTime
}

const sortByUpdatedAtDesc = (a: Record<string, any>, b: Record<string, any>): number => {
  const aTime = parseTimestamp(a.updated_at)
  const bTime = parseTimestamp(b.updated_at)
  if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0
  if (!Number.isFinite(aTime)) return 1
  if (!Number.isFinite(bTime)) return -1
  return bTime - aTime
}

const normalizeChildrenIds = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(item => safeText(item)).filter(Boolean)
  }

  const text = safeText(value).trim()
  if (!text) return []

  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.map(item => safeText(item)).filter(Boolean)
  } catch {
    return []
  }
}

const normalizeMessage = (
  msg: Record<string, any>,
  includeContentPreview: boolean,
  previewChars: number
): BaseMessageItem => {
  const content = normalizeNullableText(msg?.content)
  const plainText = normalizeNullableText(msg?.plain_text_content)

  const item: BaseMessageItem = {
    id: safeText(msg?.id),
    conversation_id: normalizeNullableText(msg?.conversation_id),
    parent_id: normalizeNullableText(msg?.parent_id),
    children_ids: normalizeChildrenIds(msg?.children_ids),
    role: safeText(msg?.role) || 'unknown',
    created_at: normalizeNullableText(msg?.created_at),
    note: normalizeNote(msg?.note),
    note_color: normalizeNullableText(msg?.note_color),
    content,
    plain_text_content: plainText,
  }

  if (includeContentPreview) {
    item.content_preview = normalizePreview(plainText || content || '', previewChars)
  }

  return item
}

const resolveNotesAction = (rawAction: unknown): 'top_level' | 'siblings' | 'all' => {
  const normalized = safeText(rawAction).trim().toLowerCase()
  if (normalized === 'siblings') return 'siblings'
  if (normalized === 'all') return 'all'
  return 'top_level'
}

const resolveChatsAction = (rawAction: unknown): 'list_chats' | 'get_chats' | 'search_chats' | 'search_messages' | 'search_notes' | 'get_notes' | 'read_branch' => {
  const normalized = safeText(rawAction).trim().toLowerCase()
  if (normalized === 'get_chats') return 'get_chats'
  if (normalized === 'search_chats') return 'search_chats'
  if (normalized === 'search_messages') return 'search_messages'
  if (normalized === 'search_notes') return 'search_notes'
  if (normalized === 'get_notes') return 'get_notes'
  if (normalized === 'read_branch') return 'read_branch'
  return 'list_chats'
}

const uniqueIds = (values: unknown): string[] => {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map(item => safeText(item).trim()).filter(Boolean)))
}

const summarizeChat = (
  conversation: Record<string, any>,
  topLevelMessages: Array<Record<string, any>>,
  includeContentPreview: boolean,
  previewChars: number
): ChatSummaryItem => ({
  id: safeText(conversation?.id),
  title: normalizeNullableText(conversation?.title),
  created_at: normalizeNullableText(conversation?.created_at),
  updated_at: normalizeNullableText(conversation?.updated_at),
  top_level_messages: topLevelMessages
    .map(msg => normalizeMessage(msg, includeContentPreview, previewChars))
    .sort(sortByCreatedAtAsc),
})

export async function executeFetchNotes(
  args: FetchNotesArgs,
  options: FetchChatsExecuteOptions
): Promise<FetchNotesResult> {
  const conversationId = safeText(args?.conversationId || options.currentConversationId).trim()
  const action = resolveNotesAction(args?.action)
  const branchPointAncestorId = safeText(args?.branchPointAncestorId).trim()

  if (!conversationId) {
    return { success: false, error: 'conversationId is required in tool execution context or args' }
  }

  if (action === 'siblings' && !branchPointAncestorId) {
    return { success: false, error: 'branchPointAncestorId is required when action="siblings"' }
  }

  const limit = clampInt(args?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const includeEmpty = args?.includeEmpty === undefined ? false : Boolean(args?.includeEmpty)
  const includeContentPreview = Boolean(args?.includeContentPreview)
  const previewChars = clampInt(args?.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)

  const allMessages = options.listMessagesByConversationId(conversationId)

  let sourceMessages: Array<Record<string, any>> = []
  let siblingCount: number | undefined

  if (action === 'siblings') {
    sourceMessages = allMessages.filter(msg => safeText(msg?.parent_id) === branchPointAncestorId)
    siblingCount = sourceMessages.length
  } else if (action === 'all') {
    sourceMessages = allMessages.filter(msg => includeEmpty || Boolean(normalizeNote(msg?.note)))
  } else {
    const topLevelProvider = options.listTopLevelUserMessagesByConversationId
    if (topLevelProvider) {
      sourceMessages = topLevelProvider(conversationId)
    } else {
      sourceMessages = allMessages.filter(msg => msg?.parent_id == null && safeText(msg?.role).toLowerCase() === 'user')
    }
  }

  const normalized = sourceMessages
    .map(msg => normalizeMessage(msg, includeContentPreview, previewChars))
    .filter(item => (includeEmpty ? true : Boolean(item.note)))
    .sort(sortByCreatedAtAsc)
    .slice(0, limit)

  return {
    success: true,
    conversationId,
    action,
    branchPointAncestorId: action === 'siblings' ? branchPointAncestorId : undefined,
    siblingCount,
    totalCount: sourceMessages.length,
    noteCount: normalized.filter(item => Boolean(item.note)).length,
    notes: normalized,
  }
}

const buildLinearBranchFromMessage = (
  startMessage: Record<string, any>,
  messageMap: Map<string, Record<string, any>>
): {
  chain: Array<Record<string, any>>
  stoppedReason: 'end_of_branch' | 'branch_point'
  nextBranchChildIds: string[]
} => {
  const chain: Array<Record<string, any>> = []
  const visited = new Set<string>()
  let cursor: Record<string, any> | undefined = startMessage
  let stoppedReason: 'end_of_branch' | 'branch_point' = 'end_of_branch'
  let nextBranchChildIds: string[] = []

  while (cursor) {
    const cursorId = safeText(cursor.id)
    if (!cursorId || visited.has(cursorId)) break

    visited.add(cursorId)
    chain.push(cursor)

    const childIds = normalizeChildrenIds(cursor.children_ids)
    if (childIds.length === 0) {
      stoppedReason = 'end_of_branch'
      nextBranchChildIds = []
      break
    }

    if (childIds.length > 1) {
      stoppedReason = 'branch_point'
      nextBranchChildIds = childIds
      break
    }

    cursor = messageMap.get(childIds[0])
  }

  return { chain, stoppedReason, nextBranchChildIds }
}

async function executePage(
  args: FetchChatsArgs,
  options: FetchChatsExecuteOptions
): Promise<FetchChatsResult> {
  const action = resolveChatsAction(args?.action)
  const includeContentPreview = args?.includeContentPreview === undefined ? true : Boolean(args?.includeContentPreview)
  const previewChars = clampInt(args?.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)
  const limit = clampInt(args?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)

  const skip = clampInt(args.skip, 0, 0, Number.MAX_SAFE_INTEGER)
  if (action === 'list_chats' || action === 'get_chats' || action === 'search_chats') {
    const query = action === 'search_chats' ? safeText(args.query).trim() : undefined
    if (action === 'search_chats' && !query) return { success: false, error: 'query is required for search_chats' }
    const contextId = args.conversationId || options.currentConversationId
    const userId = safeText(args.userId).trim() || (contextId ? safeText(options.getConversationById(contextId)?.user_id) : '')
    const projectId = safeText(args.projectId).trim() || undefined
    if (action === 'search_chats' && !userId) return { success: false, error: 'userId or current conversation is required for search_chats' }
    let conversations: Array<Record<string, any>>
    if (action === 'get_chats') {
      const ids = uniqueIds([args.conversationId, ...(args.conversationIds || [])])
      if (!ids.length) return { success: false, error: 'conversationId or conversationIds is required for get_chats' }
      conversations = ids.map(id => options.getConversationById(id)).filter((row): row is Record<string, any> => Boolean(row))
        .slice(skip, skip + limit + 1)
    } else if (options.listConversationsPage) {
      conversations = options.listConversationsPage({ userId: userId || undefined, projectId,
        updatedAfter: args.updatedAfter, updatedBefore: args.updatedBefore, query, skip, limit: limit + 1 })
    } else {
      conversations = options.listConversations().filter(row =>
        (!userId || row.user_id === userId) && (!projectId || row.project_id === projectId) &&
        (!args.updatedAfter || parseTimestamp(row.updated_at) >= Date.parse(args.updatedAfter)) &&
        (!args.updatedBefore || parseTimestamp(row.updated_at) < Date.parse(args.updatedBefore)) &&
        (!query || safeText(row.title).toLowerCase().includes(query.toLowerCase()) ||
          safeText(row.title).toLowerCase().replace(/[\s_-]+/g, '').includes(query.toLowerCase().replace(/[\s_-]+/g, '')))
      ).sort((a, b) => sortByUpdatedAtDesc(a, b) || safeText(a.id).localeCompare(safeText(b.id)))
        .slice(skip, skip + limit + 1)
    }
    const mode = args.responseMode || 'metadata'
    const messageSkip = clampInt(args.messageSkip, 0, 0, Number.MAX_SAFE_INTEGER)
    const messageLimit = clampInt(args.messageLimit, 10, 1, MAX_LIMIT)
    const chats = conversations.slice(0, limit).map(conversation => {
      const id = safeText(conversation.id)
      const metadata = { id, title: normalizeNullableText(conversation.title),
        created_at: normalizeNullableText(conversation.created_at), updated_at: normalizeNullableText(conversation.updated_at) }
      if (mode === 'metadata' && options.countTopLevelUserMessages) {
        return { ...metadata, rootMessageCount: options.countTopLevelUserMessages(id) }
      }
      const messages = options.listTopLevelUserMessagesByConversationId
        ? options.listTopLevelUserMessagesByConversationId(id)
        : options.listMessagesByConversationId(id).filter(msg => msg.parent_id == null && msg.role === 'user')
      if (mode === 'metadata') return { ...metadata, rootMessageCount: messages.length }
      const summary = summarizeChat(conversation, messages.slice(messageSkip, messageSkip + messageLimit), includeContentPreview, previewChars)
      return { ...summary, rootMessageCount: messages.length, messageSkip,
        hasMoreMessages: messageSkip + messageLimit < messages.length }
    })
    return { success: true, action, chats, skip, returnedCount: chats.length, hasMore: conversations.length > limit }
  }

  if (action === 'search_messages') {
    const query = safeText(args?.query).trim()
    if (!query) {
      return { success: false, error: 'query is required when action="search_messages"' }
    }

    const scopedConversationId = safeText(args?.conversationId || options.currentConversationId).trim()
    if (scopedConversationId) {
      const conversation = options.getConversationById(scopedConversationId)
      if (!conversation) {
        return { success: false, error: `Conversation not found: ${scopedConversationId}` }
      }

      const messageSearchResults = options
        .listMessagesByConversationId(scopedConversationId)
        .map((msg): MessageSearchItem => {
          const messageText = safeText(msg?.plain_text_content) || safeText(msg?.content)
          const note = normalizeNote(msg?.note)
          const score = calculateMessageSearchScore(query, messageText, note)
          return {
            conversation_id: scopedConversationId,
            project_id: normalizeNullableText(conversation?.project_id),
            storage_mode: safeText(conversation?.storage_mode) === 'cloud' ? 'cloud' : 'local',
            conversation_title: normalizeNullableText(conversation?.title),
            message_id: safeText(msg?.id),
            message_created_at: safeText(msg?.created_at),
            conversation_updated_at: normalizeNullableText(conversation?.updated_at),
            content: buildSearchSnippet(messageText || note || '', query),
            note,
            match_type: 'fallback' as const,
            score,
          }
        })
        .filter(item => item.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          return parseTimestamp(b.message_created_at) - parseTimestamp(a.message_created_at)
        })
        .slice(0, limit)

      return {
        success: true,
        action,
        conversationId: scopedConversationId,
        totalCount: messageSearchResults.length,
        messageSearchResults,
      }
    }

    const explicitUserId = safeText(args?.userId).trim()
    const projectId = safeText(args?.projectId).trim() || undefined
    const inferredConversationId = safeText(args?.conversationId || options.currentConversationId).trim()
    const inferredUserId = inferredConversationId ? safeText(options.getConversationById(inferredConversationId)?.user_id).trim() : ''
    const userId = explicitUserId || inferredUserId

    if (!userId) {
      return {
        success: false,
        error: 'conversationId/current conversation or userId is required for search_messages',
      }
    }

    const messageSearchResults = options.searchTopLevelMessages
      ? options.searchTopLevelMessages({ userId, projectId, query, limit }).map((result): MessageSearchItem => ({
          conversation_id: safeText(result?.conversation_id),
          project_id: normalizeNullableText(result?.project_id),
          storage_mode: safeText(result?.storage_mode) === 'cloud' ? 'cloud' : 'local',
          conversation_title: normalizeNullableText(result?.conversation_title),
          message_id: safeText(result?.message_id),
          message_created_at: safeText(result?.message_created_at),
          conversation_updated_at: normalizeNullableText(result?.conversation_updated_at),
          content: safeText(result?.content),
          note: normalizeNote(result?.note),
          match_type:
            safeText(result?.match_type) === 'fts'
              ? 'fts'
              : safeText(result?.match_type) === 'fuzzy'
                ? 'fuzzy'
                : 'fallback',
          score: typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
        }))
      : []

    return {
      success: true,
      action,
      totalCount: messageSearchResults.length,
      messageSearchResults,
    }
  }

  if (action === 'search_notes') {
    const query = safeText(args?.query).trim()
    if (!query) {
      return { success: false, error: 'query is required when action="search_notes"' }
    }

    const explicitUserId = safeText(args?.userId).trim()
    const projectId = safeText(args?.projectId).trim() || undefined
    const inferredConversationId = safeText(args?.conversationId || options.currentConversationId).trim()
    const inferredUserId = inferredConversationId ? safeText(options.getConversationById(inferredConversationId)?.user_id).trim() : ''
    const userId = explicitUserId || inferredUserId

    if (!userId) {
      return {
        success: false,
        error: 'userId is required for search_notes unless it can be inferred from conversationId/current conversation',
      }
    }

    const noteSearchResults = options.searchNotes
      ? options.searchNotes({ userId, projectId, query, limit }).map((result): NoteSearchItem => ({
          conversation_id: safeText(result?.conversation_id),
          project_id: normalizeNullableText(result?.project_id),
          storage_mode: safeText(result?.storage_mode) === 'cloud' ? 'cloud' : 'local',
          conversation_title: normalizeNullableText(result?.conversation_title),
          message_id: safeText(result?.message_id),
          message_created_at: safeText(result?.message_created_at),
          note_updated_at: normalizeNullableText(result?.note_updated_at),
          note: safeText(result?.note),
          match_type:
            safeText(result?.match_type) === 'vector'
              ? 'vector'
              : safeText(result?.match_type) === 'fuzzy'
                ? 'fuzzy'
                : 'fts',
          score: typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
          lexical_score:
            typeof result?.lexical_score === 'number' && Number.isFinite(result.lexical_score)
              ? result.lexical_score
              : undefined,
          vector_score:
            typeof result?.vector_score === 'number' && Number.isFinite(result.vector_score) ? result.vector_score : undefined,
          recency_score:
            typeof result?.recency_score === 'number' && Number.isFinite(result.recency_score)
              ? result.recency_score
              : undefined,
          vector_distance:
            typeof result?.vector_distance === 'number' && Number.isFinite(result.vector_distance)
              ? result.vector_distance
              : null,
        }))
      : []

    return {
      success: true,
      action,
      totalCount: noteSearchResults.length,
      noteSearchResults,
    }
  }

  if (action === 'get_notes') {
    const conversationId = safeText(args.conversationId || options.currentConversationId)
    if (!conversationId) return { success: false, error: 'conversationId is required for get_notes' }
    const notes = options.listMessagesByConversationId(conversationId)
      .filter(msg => args.includeEmpty || Boolean(normalizeNote(msg.note)))
      .sort((a, b) => sortByCreatedAtAsc({ created_at: a.created_at }, { created_at: b.created_at }))
    return { success: true, action, conversationId, totalCount: notes.length,
      notes: notes.slice(skip, skip + limit).map(msg => normalizeMessage(msg, false, previewChars)),
      hasMore: skip + limit < notes.length }
  }

  const messageId = safeText(args?.messageId).trim()
  if (!messageId) {
    return { success: false, error: 'messageId is required when action="read_branch"' }
  }

  const startMessage = options.getMessageById(messageId)
  if (!startMessage) {
    return { success: false, error: `Message not found: ${messageId}` }
  }

  const conversationId = safeText(startMessage?.conversation_id).trim()
  if (!conversationId) {
    return { success: false, error: `Message ${messageId} is missing conversation_id` }
  }

  const allMessages = options.listMessagesByConversationId(conversationId)
  const messageMap = new Map(allMessages.map(msg => [safeText(msg?.id), msg]))
  const { chain, stoppedReason, nextBranchChildIds } = buildLinearBranchFromMessage(startMessage, messageMap)
  const eligible = chain.filter(msg =>
    (args.includeToolMessages || ['user', 'assistant'].includes(safeText(msg.role))) &&
    (args.includeSyntheticMessages || (!isContextInjectionMessage(msg) && msg.note !== '__auto_compaction_summary__')))
  const offset = clampInt(args?.offset, DEFAULT_BRANCH_OFFSET, 1, MAX_BRANCH_OFFSET)
  const sliced = eligible.slice(skip, skip + offset)
  return { success: true, action, conversationId, messageId, skip, offset,
    totalCount: eligible.length, returnedCount: sliced.length, hasMore: skip + offset < eligible.length,
    stoppedReason, nextBranchChildIds,
    branchMessages: sliced.map((msg, index) => ({ ...normalizeMessage(msg, includeContentPreview, previewChars), sequence_index: skip + index })) }
}

type ResponseMode = NonNullable<FetchChatsArgs['responseMode']>

function projectMessage(message: any, mode: ResponseMode): any {
  const { content, plain_text_content, content_preview, note, note_color, previewChars, ...metadata } = message
  if (mode === 'metadata') return metadata
  if (mode === 'notes') return { id: message.id, conversation_id: message.conversation_id, created_at: message.created_at, note }
  if (mode === 'preview') return { ...metadata, content_preview: normalizePreview(plain_text_content || content || content_preview, clampInt(previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)) }
  return { ...metadata, content: plain_text_content || content || '', note, note_color }
}

// Text fields can be continued within a single oversized record. IDs/tree fields
// remain intact, so callers can identify each partial record without replay dumps.
const BODY_FIELDS = new Set(['content', 'content_preview', 'note', 'title', 'conversation_title'])
function sliceRecordText(value: any, start: number, length: number): { value: any; total: number; splitSurrogate: boolean } {
  let position = 0
  let splitSurrogate = false
  const visit = (item: any): any => {
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (typeof child === 'string' && BODY_FIELDS.has(key)) {
        const from = Math.max(0, start - position)
        const to = Math.max(0, Math.min(child.length, start + length - position))
        if (to > from && to < child.length && /[\uD800-\uDBFF]/.test(child[to - 1]) && /[\uDC00-\uDFFF]/.test(child[to])) splitSurrogate = true
        position += child.length
        return [key, child.slice(from, Math.max(from, to))]
      }
      return [key, visit(child)]
    }))
  }
  const result = visit(value)
  return { value: result, total: position, splitSurrogate }
}

export async function execute(args: FetchChatsArgs, options: FetchChatsExecuteOptions): Promise<FetchChatsResult> {
  const actions = ['list_chats', 'get_chats', 'search_chats', 'search_messages', 'search_notes', 'get_notes', 'read_branch']
  if (args.action !== undefined && !actions.includes(args.action)) return { success: false, error: 'Unknown fetch_chats action' }
  const action = resolveChatsAction(args.action)
  const mode = args.responseMode || (action === 'get_notes' || action === 'search_notes' ? 'notes' :
    action === 'read_branch' || action === 'search_messages' ? (args.includeContentPreview === false ? 'metadata' : 'preview') : 'metadata')
  if (!['metadata', 'notes', 'preview', 'full'].includes(mode)) return { success: false, error: 'Invalid responseMode' }
  for (const date of [args.updatedAfter, args.updatedBefore]) {
    if (date !== undefined && !Number.isFinite(Date.parse(date))) return { success: false, error: 'Date filters must be valid ISO timestamps' }
  }
  const budget = clampInt(args.maxOutputChars, DEFAULT_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS)
  const effectiveConversationId = args.conversationId || options.currentConversationId || null
  const cursorScope = {
    action, mode, conversationId: effectiveConversationId, conversationIds: uniqueIds(args.conversationIds),
    userId: args.userId || (effectiveConversationId ? options.getConversationById(effectiveConversationId)?.user_id : null) || null,
    projectId: args.projectId || null, query: args.query || null, messageId: args.messageId || null,
    updatedAfter: args.updatedAfter || null, updatedBefore: args.updatedBefore || null,
    limit: clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT), offset: clampInt(args.offset, DEFAULT_BRANCH_OFFSET, 1, MAX_BRANCH_OFFSET),
    messageLimit: clampInt(args.messageLimit, 10, 1, MAX_LIMIT), messageSkip: clampInt(args.messageSkip, 0, 0, Number.MAX_SAFE_INTEGER),
    previewChars: clampInt(args.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS), includeEmpty: Boolean(args.includeEmpty),
    includeToolMessages: Boolean(args.includeToolMessages), includeSyntheticMessages: Boolean(args.includeSyntheticMessages),
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(cursorScope)).digest('hex').slice(0, 16)
  let skip = clampInt(args.skip, 0, 0, Number.MAX_SAFE_INTEGER)
  let contentOffset = 0
  if (args.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'))
      if (parsed.fingerprint !== fingerprint || parsed.action !== action || parsed.mode !== mode || !Number.isSafeInteger(parsed.skip) || parsed.skip < 0 ||
        !Number.isSafeInteger(parsed.contentOffset) || parsed.contentOffset < 0) throw new Error('Invalid cursor')
      skip = parsed.skip
      contentOffset = parsed.contentOffset
    } catch { return { success: false, error: 'Invalid continuation cursor' } }
  }
  // Search providers cap candidates at 200. Other actions page directly.
  const search = action === 'search_messages' || action === 'search_notes'
  const result = await executePage({ ...args, responseMode: mode, skip, limit: search ? MAX_LIMIT : args.limit }, options)
  if (!result.success) return JSON.stringify(result).length <= budget ? result : { success: false, error: 'Retrieval failed' }
  const key = result.chats ? 'chats' : result.branchMessages ? 'branchMessages' : result.notes ? 'notes' :
    result.messageSearchResults ? 'messageSearchResults' : 'noteSearchResults'
  let records: any[] = (result[key] as any[]) || []
  if (search) {
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
    result.hasMore = skip + limit < records.length
    records = records.slice(skip, skip + limit)
  }
  records = records.map(record => {
    if (key === 'chats') return { ...record, ...(record.top_level_messages ? {
      top_level_messages: record.top_level_messages.map((msg: any) => projectMessage({ ...msg, previewChars: args.previewChars }, mode)),
    } : {}) }
    if (key === 'branchMessages' || key === 'notes') return projectMessage({ ...record, previewChars: args.previewChars }, mode)
    const { content, note, ...metadata } = record
    if (mode === 'metadata') return metadata
    if (mode === 'notes') return { ...metadata, note }
    if (mode === 'preview') return { ...metadata, content_preview: normalizePreview(content || note, clampInt(args.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)) }
    return record
  })
  const output: FetchChatsResult = { ...result, [key]: [], responseMode: mode, skip,
    returnedCount: 0, omittedCount: records.length, omittedChars: 0, truncated: false, contentOffset }
  const cursor = (nextSkip: number, nextOffset = 0) => Buffer.from(JSON.stringify({ action, mode, fingerprint, skip: nextSkip, contentOffset: nextOffset })).toString('base64url')
  const accepted: any[] = []
  // Reserve continuation and accounting overhead before accepting any records.
  for (const record of records) {
    const candidate = contentOffset ? sliceRecordText(record, contentOffset, Number.MAX_SAFE_INTEGER).value : record
    const trial = { ...output, [key]: [...accepted, candidate], nextCursor: cursor(skip + accepted.length + 1), hasMore: true }
    if (JSON.stringify(trial).length > budget - 256) break
    accepted.push(candidate)
    contentOffset = 0
  }
  let nextOffset = 0
  let advanced = accepted.length
  if (!accepted.length && records.length) {
    const record = records[0]
    const total = sliceRecordText(record, 0, 0).total
    let low = 0
    let high = Math.max(0, total - contentOffset)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const trial = { ...output, [key]: [sliceRecordText(record, contentOffset, mid).value], nextCursor: cursor(skip, contentOffset + mid), hasMore: true }
      if (JSON.stringify(trial).length <= budget - 256) low = mid
      else high = mid - 1
    }
    if (sliceRecordText(record, contentOffset, low).splitSurrogate) low--
    if (!low) return { success: false, error: 'Record metadata exceeds output budget; increase maxOutputChars or reduce messageLimit' }
    accepted.push(sliceRecordText(record, contentOffset, low).value)
    nextOffset = contentOffset + low
    if (nextOffset >= total) { nextOffset = 0; advanced = 1 }
    output.omittedChars = Math.max(0, total - contentOffset - low)
  }
  output[key] = accepted as any
  output.returnedCount = accepted.length
  output.omittedCount = records.length - advanced
  output.truncated = advanced < records.length || nextOffset > 0
  output.hasMore = Boolean(result.hasMore || output.truncated)
  if (output.hasMore) output.nextCursor = cursor(skip + advanced, nextOffset)
  if (result.chats?.some(chat => chat.hasMoreMessages)) {
    output.nextMessageSkip = clampInt(args.messageSkip, 0, 0, Number.MAX_SAFE_INTEGER) + clampInt(args.messageLimit, 10, 1, MAX_LIMIT)
  }
  if (JSON.stringify(output).length > budget) return { success: false, error: 'Response metadata exceeds output budget; increase maxOutputChars' }
  return output
}
