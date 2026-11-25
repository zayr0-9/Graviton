import { DecisionAbortedError, type DecisionBroker } from './decisionBroker.js'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import {
  transcriptTextParts, type TranscriptRevision, type TranscriptRevisionPreview, type TranscriptTextChange,
} from '../../../../../shared/transcriptRevision.js'
import type { ConversationRepo } from '../persistence/conversationRepo.js'
import type { LineageRepo } from '../persistence/lineageRepo.js'
import type { TranscriptRevisionRepo } from '../persistence/transcriptRevisionRepo.js'

const PAGE_SIZE = 20
const TEXT_PAGE_SIZE = 8_000
const MAX_EDIT_SIZE = 8_000
const MAX_EDITS = 8
const MAX_PREVIEW_SIZE = 24_000
const MAX_REPLY_SIZE = 250_000

function array(value: unknown): any[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
}

/** Unlike inference hydration, an invalid anchor must never fall back to the whole conversation. */
function ancestry(repo: ConversationRepo, conversationId: string, anchor: string | null): any[] {
  const path: any[] = []
  const seen = new Set<string>()
  for (let id = anchor; id;) {
    const row = repo.getMessageById(id)
    if (seen.has(id) || row?.conversation_id !== conversationId) throw new Error('The transcript path changed. Refresh and try again.')
    seen.add(id)
    path.push(row)
    id = row.parent_id || null
  }
  return path
}

function editableParts(row: any, runById: (id: string) => any): string[] | null {
  if (row.role !== 'assistant' || row.partial || row.ex_agent_session_id || row.note === '__auto_compaction_summary__') return null
  try {
    const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta
    if (meta?.kind === 'compaction_summary' || meta?.compactionPhase === 'summarising' || meta?.transcriptPartial || meta?.claude?.partial ||
        ['terminal_error', 'compaction_summary'].includes(meta?.runStatistics?.kind)) return null
    const run = meta?.runStatistics?.streamId ? runById(meta.runStatistics.streamId) : null
    if (run?.status === 'running' || (run && run.status !== 'completed' &&
      (!run.final_message_id || run.final_message_id === row.id))) return null
    // Match the renderer’s stable index sort while keeping the same ordinal across non-text blocks.
    const blocks = array(row.content_blocks).map((block, order) => ({ block, index: typeof block?.index === 'number' ? block.index : order }))
      .sort((a, b) => a.index - b.index).map(({ block }) => block)
    if (blocks.some(block => block?.type === 'error')) return null
    const parts = transcriptTextParts(row.content, blocks)
    return parts.some(part => part.trim()) ? parts : null
  } catch { return null }
}

function displayedParts(parts: string[], revision?: TranscriptRevision): string[] {
  if (!revision) return parts
  if (revision.changes.some(change => parts[change.index] !== change.original)) {
    throw new Error('The original reply changed after its last revision. Undo the earlier revision before editing again.')
  }
  const visible = parts.slice()
  for (const change of revision.changes) visible[change.index] = change.revised
  return visible
}

function buildPatch(parts: string[], edits: unknown): { parts: string[]; preview: TranscriptRevisionPreview['edits'] } {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS) throw new Error('Provide 1–8 exact replacements.')
  let budget = 0
  const ranges = new Map<number, { start: number; end: number; after: string }[]>()
  const preview = edits.map(edit => {
    const { block, before, after } = edit ?? {}
    if (!Number.isInteger(block) || block < 0 || block >= parts.length || typeof before !== 'string' ||
      !before.trim() || typeof after !== 'string' || before === after || before.length > MAX_EDIT_SIZE || after.length > MAX_EDIT_SIZE) {
      throw new Error('Invalid replacement: supply a visible text block, unique before text and different after text.')
    }
    budget += before.length + after.length
    if (budget > MAX_PREVIEW_SIZE) throw new Error('The proposed diff is too large. Make a smaller revision.')
    const start = parts[block].indexOf(before)
    if (start < 0 || parts[block].indexOf(before, start + 1) !== -1) {
      throw new Error('The before text must match exactly once in its block. Read the target and include more context.')
    }
    const end = start + before.length
    const prior = ranges.get(block) ?? []
    if (prior.some(range => start < range.end && end > range.start)) throw new Error('Replacements cannot overlap.')
    ranges.set(block, [...prior, { start, end, after }])
    return { block, before, after }
  })
  const revised = parts.map((part, index) => {
    for (const { start, end, after } of (ranges.get(index) ?? []).sort((a, b) => b.start - a.start)) {
      part = part.slice(0, start) + after + part.slice(end)
    }
    return part
  })
  if (!revised.some(part => part.trim())) throw new Error('A revision cannot remove the entire reply.')
  if (revised.every((part, index) => part === parts[index])) throw new Error('The replacements do not change the reply.')
  if (revised.reduce((sum, part) => sum + part.length, 0) > MAX_REPLY_SIZE) throw new Error('The revised reply is too large.')
  return { parts: revised, preview }
}

export type TranscriptRevisionTool = (toolCallId: string, args: any, signal?: AbortSignal) => Promise<unknown>

export function createTranscriptRevisionTool(deps: {
  conversationId: string
  lineageId: string
  userMessageId: string
  anchor: string
  streamId: string
  messages: ConversationRepo
  lineages: LineageRepo
  revisions: TranscriptRevisionRepo
  runById: (id: string) => any
  broker: DecisionBroker
  emit: (event: HeadlessStreamEvent) => void
}): TranscriptRevisionTool {
  const { conversationId, lineageId, userMessageId, anchor, streamId, messages, lineages, revisions, runById, broker, emit } = deps
  const scopedPath = () => {
    const lineage = lineages.get(lineageId)
    const user = messages.getMessageById(userMessageId)
    if (lineage?.conversation_id !== conversationId || lineage.status !== 'active' || !lineage.head_message_id ||
        user?.role !== 'user' || user.parent_id !== anchor ||
        !ancestry(messages, conversationId, lineage.head_message_id).some(row => row.id === userMessageId)) {
      throw new Error('The revision request is no longer on its original lineage.')
    }
    return ancestry(messages, conversationId, anchor)
  }
  // Capture prior membership before inference. A repointed path or late row can narrow this set, never extend it.
  const priorReplies = new Set(scopedPath().filter(row => editableParts(row, runById)).map(row => row.id))
  const target = (messageId: string) => {
    const row = scopedPath().find(row => row.id === messageId)
    const parts = row && priorReplies.has(messageId) ? editableParts(row, runById) : null
    if (!parts) throw new Error('Select a completed assistant reply that was already on this lineage when the revision turn began.')
    return { row, parts }
  }
  let proposalPending = false
  let applied = false
  let rejected = false
  return async (toolCallId, args, signal) => {
    signal?.throwIfAborted()
    if (args?.action === 'list') {
      const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
      const replies = scopedPath().flatMap(row => {
        if (!priorReplies.has(row.id)) return []
        const parts = editableParts(row, runById)
        return parts ? [{ messageId: row.id, date: row.created_at, excerpt: parts.find(part => part.trim())!.trim().slice(0, 220) }] : []
      })
      const metadata = { count: replies.length, nextOffset: offset + PAGE_SIZE < replies.length ? offset + PAGE_SIZE : null }
      return { persistedContent: metadata, modelContent: { ...metadata, replies: replies.slice(offset, offset + PAGE_SIZE) } }
    }
    const messageId = args?.messageId
    if (typeof messageId !== 'string' || !messageId || messageId.length > 160) throw new Error('A valid messageId is required.')
    const { row, parts } = target(messageId)
    const current = revisions.latest(lineageId, messageId)
    const visible = displayedParts(parts, current)
    if (visible.reduce((sum, part) => sum + part.length, 0) > MAX_REPLY_SIZE) {
      throw new Error('This reply is too large to revise. Ask the assistant for a new answer instead.')
    }
    if (args.action === 'read') {
      const index = args.block ?? 0
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(index) || index < 0 || index >= visible.length || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('Provide a valid text block and character offset.')
      }
      const part = visible[index]
      const text = part.slice(offset, offset + TEXT_PAGE_SIZE)
      const metadata = { messageId, block: index, blockCount: visible.length, offset,
        nextOffset: offset + text.length < part.length ? offset + text.length : null }
      return { persistedContent: metadata, modelContent: { ...metadata, text } }
    }
    if (args.action !== 'propose') throw new Error('Use list, read, or propose.')
    if (proposalPending || applied || rejected) throw new Error('Only one revision can be approved or declined per request. Ask the user for a new /revise turn.')
    const patch = buildPatch(visible, args.edits)
    const changes: TranscriptTextChange[] = parts.flatMap((original, index) =>
      original === patch.parts[index] ? [] : [{ index, original, revised: patch.parts[index] }])
    const prompt = { type: 'permission_required' as const, streamId, toolCallId, toolName: 'revise_transcript',
      toolInput: {}, transcriptRevision: { messageId, messageDate: row.created_at,
        excerpt: visible.find(part => part.trim())!.trim().slice(0, 220), edits: patch.preview } }
    proposalPending = true
    try {
      const pending = broker.requestDecision({ streamId, toolCallId, kind: 'transcript_revision', signal, prompt })
      if (broker.hasPending(streamId, toolCallId)) emit(prompt)
      if (await pending !== 'approve_transcript_revision') {
        rejected = true
        throw new Error('Tool execution denied by user. Do not propose the edit again on this turn.')
      }
      if (signal?.aborted) throw new DecisionAbortedError()
      const revisionId = revisions.apply(conversationId, lineageId, messageId, current?.id ?? null, changes, () => {
        if (JSON.stringify(target(messageId).parts) !== JSON.stringify(parts)) {
          throw new Error('The reply changed while approval was pending. Read it and propose again.')
        }
      })
      applied = true
      return { applied, messageId, revisionId, instruction: 'Confirm briefly. Do not reprint the answer. This changes how the reply is displayed on this lineage, not provider history.' }
    } finally { proposalPending = false }
  }
}
