import { parseMessageMeta, renderSystemReminder } from './contextInjection.js'

export const LEGACY_COMPACTION_NOTE = '__auto_compaction_summary__'
export const COMPACTION_RESUME_PREFIX = 'Following is summary of the session, you have to resume the work.'
export const DEFAULT_COMPACTION_INSTRUCTIONS = 'Return a structured Markdown state handoff: objective and constraints; investigations and decisions; latest state and accomplishments; validation and unresolved risks; next steps and active references. Include absolute paths of files touched and what the changes accomplish.'

// Always included, even when the user supplies custom summary instructions.
export const COMPACTION_HANDOFF_INSTRUCTIONS = `The harness will append a filtered tool-interaction record after your response. Do not reproduce tool calls, argument JSON, raw outputs, file contents, patches, or a chronological call-by-call log.
Explain the purpose and direction of investigations and edits, grouping related activity by what it was intended to establish or accomplish. Preserve the user's objective, hard constraints, decisions and reasons.
Describe the latest known state: what changed, what those changes accomplish, what remains incomplete, and which earlier approaches were superseded or reverted. Distinguish successful changes from attempted changes and verified facts from assumptions.
Preserve consequential findings from tool outputs because many outputs will be omitted or truncated in the appendix. Include confirmed root causes, important review findings and their disposition, actual validation results, unresolved errors, and evidence needed to continue correctly. Do not claim tests or builds passed without observed results.
Preserve exact paths, identifiers, commands and source URLs where needed for continuation, without their surrounding payloads. Retain still-needed older references and enduring findings from previous summaries, but do not copy their tool appendices.
End with concrete next steps and active jobs, sessions, watches or temporary state that must be checked. REPL variables are memory-only references, not guaranteed available; check availability before reuse. Inspect git status and relevant diffs before relying on mutation history, and read affected files when untracked, committed or outside Git.
Summarise this session only; do not resume the original task in this response.`
export const DEFAULT_COMPACTION_THRESHOLD = 85

export function normalizeCompactionThreshold(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(95, Math.round(value))) : DEFAULT_COMPACTION_THRESHOLD
}

export function isCommittedCompaction(message: any): boolean {
  const meta = parseMessageMeta(message?.meta)
  if (meta?.kind === 'compaction_summary') return meta.state === 'committed' && message.role === 'assistant'
  if (message?.note === LEGACY_COMPACTION_NOTE) return true
  return (message?.role === 'system' || message?.role === 'developer') &&
    String(message.content ?? message.plain_text_content ?? message.content_plain_text ?? '').trim().startsWith(COMPACTION_RESUME_PREFIX)
}

export function isCompactionControl(message: any): boolean {
  const kind = parseMessageMeta(message?.meta)?.kind
  return kind === 'compaction_instruction' || kind === 'compaction_resume'
}

export function compactionInstruction(custom?: string | null): string {
  return renderSystemReminder([`Context compaction requested. Produce a complete session summary as your response.\n${custom?.trim() || DEFAULT_COMPACTION_INSTRUCTIONS}\n${COMPACTION_HANDOFF_INSTRUCTIONS}\nPreserve the current task and next steps. This is a summary turn, not a request to finish the original task.`])
}

export function compactionResumeInstruction(): string {
  return renderSystemReminder(['Context compaction is complete. Resume the interrupted work using the preceding summary and restored instructions. Do not summarise again. Follow any newer user instructions.'])
}

/** The summary's usage describes the old request, not the newly compacted replay. */
export function contextUsageAfterCompaction(messages: any[]): any[] {
  let boundary = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCommittedCompaction(messages[i])) { boundary = i; break }
  }
  return messages.slice(boundary < 0 ? 0 : boundary).map((message, index) => {
    if (boundary < 0 || index !== 0) return message
    let blocks = message.content_blocks
    if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks) } catch { blocks = [] } }
    return { ...message, context_usage: undefined,
      content_blocks: Array.isArray(blocks) ? blocks.filter(block => block?.type !== 'openai_context_usage') : blocks }
  })
}

/** On a new run, abandoned control instructions must not commandeer the next task. */
export function excludeAbandonedCompactionControls<T extends { meta?: unknown }>(messages: T[], activeInstructionId?: string): T[] {
  return messages.filter(message => parseMessageMeta(message.meta)?.kind !== 'compaction_instruction' ||
    (message as any).id === activeInstructionId)
}

/** Includes intermediate/partial responses, without treating them as replay boundaries. */
export function isCompactionResponse(message: any): boolean {
  return isCommittedCompaction(message) ||
    (message?.role === 'assistant' && parseMessageMeta(message.meta)?.compactionPhase === 'summarising')
}

export function isCompactionMessage(message: any): boolean {
  return isCompactionControl(message) || isCompactionResponse(message)
}
