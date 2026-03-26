export interface FetchNotesArgs {
  action?: 'top_level' | 'siblings'
  branchPointAncestorId?: string
  limit?: number
  includeEmpty?: boolean
  includeContentPreview?: boolean
  previewChars?: number
}

interface FetchNotesExecuteOptions {
  conversationId?: string | null
  listMessagesByConversationId: (conversationId: string) => Array<Record<string, any>>
  listTopLevelUserMessagesByConversationId?: (conversationId: string) => Array<Record<string, any>>
}

interface FetchNoteItem {
  id: string
  conversation_id: string | null
  parent_id: string | null
  role: string
  created_at: string | null
  note: string | null
  note_color: string | null
  content: string | null
  plain_text_content: string | null
  content_preview?: string | null
}

export interface FetchNotesResult {
  success: boolean
  error?: string
  conversationId?: string | null
  action?: 'top_level' | 'siblings'
  branchPointAncestorId?: string
  siblingCount?: number
  totalCount?: number
  noteCount?: number
  notes?: FetchNoteItem[]
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_PREVIEW_CHARS = 180
const MAX_PREVIEW_CHARS = 1200

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

const normalizeMessage = (
  msg: Record<string, any>,
  includeContentPreview: boolean,
  previewChars: number
): FetchNoteItem => {
  const content = normalizeNullableText(msg?.content)
  const plainText = normalizeNullableText(msg?.plain_text_content)

  const item: FetchNoteItem = {
    id: safeText(msg?.id),
    conversation_id: normalizeNullableText(msg?.conversation_id),
    parent_id: normalizeNullableText(msg?.parent_id),
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

const resolveAction = (rawAction: unknown): 'top_level' | 'siblings' => {
  const normalized = safeText(rawAction).trim().toLowerCase()
  if (normalized === 'siblings') return 'siblings'
  return 'top_level'
}

/**
 * fetch_notes supports two modes:
 * - top_level (default): returns top-level user NOTE entries for the current conversation.
 * - siblings: returns sibling NOTE entries where parent_id === branchPointAncestorId.
 *
 * By default, entries without notes are omitted (includeEmpty=false).
 */
export async function execute(args: FetchNotesArgs, options: FetchNotesExecuteOptions): Promise<FetchNotesResult> {
  const conversationId = safeText(options.conversationId)
  const action = resolveAction(args?.action)
  const branchPointAncestorId = safeText(args?.branchPointAncestorId).trim()

  if (!conversationId) {
    return { success: false, error: 'conversationId is required in tool execution context' }
  }

  if (action === 'siblings' && !branchPointAncestorId) {
    return { success: false, error: 'branchPointAncestorId is required when action="siblings"' }
  }

  const limit = clampInt(args?.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  // This tool is note-focused: by default we only return entries that actually have notes.
  const includeEmptyDefault = false
  const includeEmpty = args?.includeEmpty === undefined ? includeEmptyDefault : Boolean(args?.includeEmpty)
  const includeContentPreview = Boolean(args?.includeContentPreview)
  const previewChars = clampInt(args?.previewChars, DEFAULT_PREVIEW_CHARS, 20, MAX_PREVIEW_CHARS)

  const allMessages = options.listMessagesByConversationId(conversationId)

  let sourceMessages: Array<Record<string, any>> = []
  let siblingCount: number | undefined

  if (action === 'siblings') {
    sourceMessages = allMessages.filter(msg => safeText(msg?.parent_id) === branchPointAncestorId)
    siblingCount = sourceMessages.length
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
