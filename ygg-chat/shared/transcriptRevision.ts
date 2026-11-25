export const TRANSCRIPT_REVISION_TOOL = 'revise_transcript'

export interface TranscriptTextChange {
  /** Ordinal among text blocks, in their stored order. Legacy unblocked replies use 0. */
  index: number
  original: string
  revised: string
}

export interface TranscriptRevision {
  id: number
  messageId: string
  changes: TranscriptTextChange[]
}

export interface TranscriptRevisionPreview {
  messageId: string
  messageDate: string
  excerpt: string
  edits: { block: number; before: string; after: string }[]
}

type DisplayBlock = { type?: string; content?: unknown; items?: unknown }
type OutputItem = { type?: string; role?: string; content?: unknown }
const blockOf = (value: unknown) => value as DisplayBlock | null
const usesLegacyOutput = (blocks: readonly unknown[]) => !blocks.some(value =>
  ['text', 'thinking', 'tool_use', 'image', 'reasoning_details', 'error'].includes(blockOf(value)?.type ?? ''))

export function legacyAssistantText(item: OutputItem | null | undefined): string {
  if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) return ''
  return item.content.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim()
}

/** The original row is never changed. Use provider outputs only when the UI draws them as a legacy fallback. */
export function transcriptTextParts(content: string, blocks: readonly unknown[]): string[] {
  if (!blocks.length) return [content]
  const legacy = usesLegacyOutput(blocks)
  return blocks.flatMap(block => {
    const row = blockOf(block)
    if (row?.type === 'text' && typeof row.content === 'string') return [row.content]
    if (legacy && row?.type === 'responses_output_items' && Array.isArray(row.items)) {
      return row.items.map(legacyAssistantText).filter(Boolean)
    }
    return []
  })
}

export function projectTranscriptRevision<B>(content: string, blocks: readonly B[], revision: TranscriptRevision | undefined) {
  if (!revision) return null
  const parts = transcriptTextParts(content, blocks)
  if (!revision.changes.every(change => parts[change.index] === change.original)) return null
  for (const change of revision.changes) parts[change.index] = change.revised
  let textIndex = 0
  const legacy = usesLegacyOutput(blocks)
  return {
    content: parts.join('\n\n'),
    blocks: blocks.map(block => {
      const row = blockOf(block)
      if (row?.type === 'text' && typeof row.content === 'string') return { ...block, content: parts[textIndex++] }
      if (legacy && row?.type === 'responses_output_items' && Array.isArray(row.items)) {
        return { ...block, items: row.items.map(item => legacyAssistantText(item)
          ? { ...item, content: [{ type: 'output_text', text: parts[textIndex++] }] } : item) }
      }
      return block
    }),
  }
}

/** Parse before hooks, context expansion, or native slash command handling. */
export function parseTranscriptRevisionRequest(content: string | null | undefined): string | null {
  return /^\s*\/revise\s+([\s\S]*\S)\s*$/u.exec(content ?? '')?.[1]?.trim() ?? null
}
