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
}

interface FetchChatsExecuteOptions {
  currentConversationId?: string | null
  listConversations: () => Array<Record<string, any>>
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
  top_level_messages: BaseMessageItem[]
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
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_PREVIEW_CHARS = 180
const MAX_PREVIEW_CHARS = 1200
const DEFAULT_BRANCH_OFFSET = 10
const MAX_BRANCH_OFFSET = 200

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

export async function execute(
  args: FetchChatsArgs,
  options: FetchChatsExecuteOptions
): Promise<FetchChatsResult> {
  const action = resolveChatsAction(args?.action)
  const includeContentPreview = args?.includeContentPreview === undefined ? true : Boolean(args?.includeContentPreview)
  const previewChars = clampInt(args?.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)
  const limit = clampInt(args?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)

  if (action === 'list_chats') {
    const chats = options
      .listConversations()
      .sort(sortByUpdatedAtDesc)
      .slice(0, limit)
      .map(conversation => {
        const conversationId = safeText(conversation?.id)
        const topLevelMessages = options.listTopLevelUserMessagesByConversationId
          ? options.listTopLevelUserMessagesByConversationId(conversationId)
          : options
              .listMessagesByConversationId(conversationId)
              .filter(msg => msg?.parent_id == null && safeText(msg?.role).toLowerCase() === 'user')

        return summarizeChat(conversation, topLevelMessages, includeContentPreview, previewChars)
      })

    return {
      success: true,
      action,
      currentConversationId: normalizeNullableText(options.currentConversationId),
      totalCount: chats.length,
      chats,
    }
  }

  if (action === 'get_chats') {
    const requestedConversationIds = Array.from(
      new Set([
        safeText(args?.conversationId).trim(),
        ...uniqueIds(args?.conversationIds),
      ].filter(Boolean))
    )

    if (requestedConversationIds.length === 0) {
      return { success: false, error: 'conversationId or conversationIds is required when action="get_chats"' }
    }

    const chats = requestedConversationIds
      .map(conversationId => options.getConversationById(conversationId))
      .filter(Boolean)
      .map(conversation => {
        const conversationId = safeText(conversation?.id)
        const topLevelMessages = options.listTopLevelUserMessagesByConversationId
          ? options.listTopLevelUserMessagesByConversationId(conversationId)
          : options
              .listMessagesByConversationId(conversationId)
              .filter(msg => msg?.parent_id == null && safeText(msg?.role).toLowerCase() === 'user')

        return summarizeChat(conversation!, topLevelMessages, includeContentPreview, previewChars)
      })

    return {
      success: true,
      action,
      requestedConversationIds,
      totalCount: chats.length,
      chats,
    }
  }

  if (action === 'search_chats') {
    const query = safeText(args?.query).trim()
    if (!query) {
      return { success: false, error: 'query is required when action="search_chats"' }
    }

    const explicitUserId = safeText(args?.userId).trim()
    const projectId = safeText(args?.projectId).trim() || undefined
    const inferredConversationId = safeText(args?.conversationId || options.currentConversationId).trim()
    const inferredUserId = inferredConversationId ? safeText(options.getConversationById(inferredConversationId)?.user_id).trim() : ''
    const userId = explicitUserId || inferredUserId

    if (!userId) {
      return {
        success: false,
        error: 'userId is required for search_chats unless it can be inferred from conversationId/current conversation',
      }
    }

    const matchedConversations = options.searchConversations
      ? options.searchConversations({ userId, projectId, query, limit })
      : options
          .listConversations()
          .filter(conversation => {
            if (safeText(conversation?.user_id).trim() !== userId) return false
            if (projectId && safeText(conversation?.project_id).trim() !== projectId) return false
            const title = safeText(conversation?.title).toLowerCase()
            const normalizedTitle = title.replace(/[\s_-]+/g, '')
            const lowerQuery = query.toLowerCase()
            const normalizedQuery = lowerQuery.replace(/[\s_-]+/g, '')
            return title.includes(lowerQuery) || (normalizedQuery && normalizedTitle.includes(normalizedQuery))
          })
          .sort(sortByUpdatedAtDesc)
          .slice(0, limit)

    const chats = matchedConversations.map(conversation => {
      const conversationId = safeText(conversation?.id)
      const topLevelMessages = options.listTopLevelUserMessagesByConversationId
        ? options.listTopLevelUserMessagesByConversationId(conversationId)
        : options
            .listMessagesByConversationId(conversationId)
            .filter(msg => msg?.parent_id == null && safeText(msg?.role).toLowerCase() === 'user')

      return summarizeChat(conversation, topLevelMessages, includeContentPreview, previewChars)
    })

    return {
      success: true,
      action,
      totalCount: chats.length,
      chats,
    }
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
    const notesResult = await executeFetchNotes(
      {
        action: 'all',
        conversationId: args?.conversationId,
        branchPointAncestorId: args?.branchPointAncestorId,
        limit,
        includeEmpty: args?.includeEmpty,
        includeContentPreview,
        previewChars,
      },
      options
    )

    return {
      success: notesResult.success,
      error: notesResult.error,
      action,
      conversationId: notesResult.conversationId,
      branchPointAncestorId: notesResult.branchPointAncestorId,
      siblingCount: notesResult.siblingCount,
      totalCount: notesResult.totalCount,
      noteCount: notesResult.noteCount,
      notes: notesResult.notes,
    }
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

  const offset = clampInt(args?.offset, DEFAULT_BRANCH_OFFSET, 1, MAX_BRANCH_OFFSET)
  const skip = clampInt(args?.skip, 0, 0, Number.MAX_SAFE_INTEGER)
  const sliced = chain.slice(skip, skip + offset)

  return {
    success: true,
    action,
    conversationId,
    messageId,
    skip,
    offset,
    totalCount: chain.length,
    returnedCount: sliced.length,
    hasMore: skip + offset < chain.length,
    stoppedReason,
    nextBranchChildIds,
    branchMessages: sliced.map((msg, index) => ({
      ...normalizeMessage(msg, includeContentPreview, previewChars),
      sequence_index: skip + index,
    })),
  }
}
