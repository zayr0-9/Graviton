/**
 * Context injection contract (docs/claude_code_context_loading_rules.md §11.3
 * decisions 6 and 7, §11.5).
 *
 * Two persisted shapes carry auto-loaded context through the message tree:
 *
 *  1. A launch-time USER MESSAGE tagged `meta.kind === 'context_injection'`. Its
 *     `content` is the rendered instruction set (AGENTS.md / CLAUDE.md chain, rules,
 *     MEMORY.md); `meta.files` lists the real paths it contains. Built once per
 *     branch, directly before the user's own message, so the cached prefix holds.
 *
 *  2. A `context_injection` CONTENT BLOCK on an assistant row (beside the
 *     `tool_result` that triggered it) or on a user row (UserPromptSubmit hook
 *     output, `/skill` expansion). One block per injected file.
 *
 * Providers never see these blocks. `foldContextInjectionsForModel` rewrites a
 * history array for the model: each block's rendered text is appended to the tool
 * result (or user content) it belongs to, wrapped in a `<system-reminder>`, and the
 * blocks themselves are removed. `collectLoadedContextPaths` derives the "already
 * loaded" set from the same history so a branch edit starts with the correct set.
 */

export const CONTEXT_INJECTION_KIND = 'context_injection'
export const CONTEXT_INJECTION_BLOCK_TYPE = 'context_injection'

export type ContextInjectionReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'
  | 'hook'
  | 'skill'
  | 'memory'

export interface ContextInjectionEntry {
  /** Absolute real path of the injected file. Empty for hook output. */
  path: string
  /** Parenthetical label, e.g. "project instructions, checked into the codebase". */
  label: string
  /** Body text as delivered to the model (after comment stripping / rendering). */
  text: string
  reason: ContextInjectionReason
}

export interface ContextInjectionBlock extends ContextInjectionEntry {
  type: typeof CONTEXT_INJECTION_BLOCK_TYPE
  /** The tool call this block rides on; absent for blocks on a user row. */
  tool_use_id?: string
  index?: number
}

export interface ContextInjectionMessageMeta {
  kind: typeof CONTEXT_INJECTION_KIND
  files: string[]
  reason?: ContextInjectionReason
  [key: string]: unknown
}

export const INSTRUCTION_SET_PREAMBLE =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

export const LABEL_USER_GLOBAL = "user's private global instructions for all projects"
export const LABEL_PROJECT = 'project instructions, checked into the codebase'
export const LABEL_LOCAL = "user's private project instructions, not checked in"
export const LABEL_AUTO_MEMORY = "user's auto-memory, persists across conversations"
export const LABEL_HOOK_CONTEXT = 'hook additional context'

/** `Contents of <path> (<label>):\n\n<text>` — the observed Claude Code section format. */
export function renderContextSection(entry: Pick<ContextInjectionEntry, 'path' | 'label' | 'text'>): string {
  const header = entry.path ? `Contents of ${entry.path} (${entry.label}):` : `${entry.label}:`
  return `${header}\n\n${entry.text.trim()}`
}

/** One `<system-reminder>` wrapper around a list of sections. */
export function renderSystemReminder(sections: string[], preamble?: string | null): string {
  const body = [preamble?.trim() || null, ...sections.map(section => section.trim()).filter(Boolean)]
    .filter(Boolean)
    .join('\n\n')
  return `<system-reminder>\n${body}\n</system-reminder>`
}

/** Render the launch-time instruction set: preamble + one section per file. */
export function renderInstructionSet(entries: ContextInjectionEntry[]): string {
  return renderSystemReminder(entries.map(renderContextSection), INSTRUCTION_SET_PREAMBLE)
}

/** Render lazily injected entries that ride on a tool result or a user message. */
export function renderInjectionEntries(entries: ContextInjectionEntry[]): string {
  return renderSystemReminder(entries.map(renderContextSection))
}

export function parseMessageMeta(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object') return Array.isArray(value) ? null : (value as Record<string, unknown>)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

export function isContextInjectionMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const meta = parseMessageMeta((message as { meta?: unknown }).meta)
  return meta?.kind === CONTEXT_INJECTION_KIND
}

export function isContextInjectionBlock(block: unknown): block is ContextInjectionBlock {
  return Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === CONTEXT_INJECTION_BLOCK_TYPE)
}

function parseBlocks(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** Cheap pre-scan: a serialised block set without the marker cannot hold an injection block. */
function mayContainInjection(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(CONTEXT_INJECTION_BLOCK_TYPE)
  return Array.isArray(value) && value.length > 0
}

/**
 * Every real path already injected on this branch path: launch-time messages
 * (`meta.files`) plus `context_injection` blocks. Callers pass the history AFTER
 * `trimHistoryToLatestCompaction`, so a compaction resets the set as §2.6 requires.
 */
export function collectLoadedContextPaths(history: ReadonlyArray<unknown>): Set<string> {
  const loaded = new Set<string>()
  for (const message of history) {
    if (!message || typeof message !== 'object') continue
    const row = message as { meta?: unknown; content_blocks?: unknown }
    const meta = parseMessageMeta(row.meta)
    if (meta?.kind === CONTEXT_INJECTION_KIND && Array.isArray(meta.files)) {
      for (const file of meta.files) if (typeof file === 'string' && file) loaded.add(file)
    }
    if (!mayContainInjection(row.content_blocks)) continue
    const blocks = parseBlocks(row.content_blocks)
    if (!blocks) continue
    for (const block of blocks) {
      if (isContextInjectionBlock(block) && block.path) loaded.add(block.path)
    }
  }
  return loaded
}

/**
 * The skill names whose bodies were delivered on this branch (via `skill_manager
 * activate` results or `/skill` user invocations). Used by the compaction re-attach.
 */
export function collectInvokedSkillEntries(history: ReadonlyArray<unknown>): Map<string, ContextInjectionEntry> {
  const latest = new Map<string, ContextInjectionEntry>()
  for (const message of history) {
    if (!message || typeof message !== 'object') continue
    const row = message as { content_blocks?: unknown }
    if (!mayContainInjection(row.content_blocks)) continue
    const blocks = parseBlocks(row.content_blocks)
    if (!blocks) continue
    for (const block of blocks) {
      if (!isContextInjectionBlock(block) || block.reason !== 'skill') continue
      const name = block.path || block.label
      latest.set(name, { path: block.path, label: block.label, text: block.text, reason: 'skill' })
    }
  }
  return latest
}

function appendTextToContent(content: unknown, text: string): unknown {
  if (typeof content === 'string') return content ? `${content}\n\n${text}` : text
  if (Array.isArray(content)) return [...content, { type: 'text', text }]
  if (content == null) return text
  try {
    return `${JSON.stringify(content)}\n\n${text}`
  } catch {
    return `${String(content)}\n\n${text}`
  }
}

/**
 * Rewrite a history array for the model. Pure: returns new row objects where a
 * change was needed and the original rows elsewhere.
 *
 *  - Assistant rows: `context_injection` blocks are grouped by `tool_use_id`; their
 *    rendered text is appended to the matching `tool_result` block's content, then the
 *    injection blocks are removed. Blocks with no matching tool result are appended to
 *    the last tool result of the row.
 *  - `role: 'tool'` rows (in-loop history) whose `tool_call_id` matches such a block
 *    get the same text appended to `content`.
 *  - User rows: injection blocks are appended to `content` and removed.
 *
 * Rows serialise `content_blocks` in the shape they arrived (string in, string out).
 */
export function foldContextInjectionsForModel<T>(history: ReadonlyArray<T>): T[] {
  const injectionByToolUse = new Map<string, ContextInjectionEntry[]>()
  const output: T[] = []

  for (const message of history) {
    if (!message || typeof message !== 'object') {
      output.push(message)
      continue
    }
    const row = message as unknown as {
      role?: unknown
      content?: unknown
      content_blocks?: unknown
      tool_call_id?: unknown
    }

    if (row.role === 'tool' && typeof row.tool_call_id === 'string') {
      const pending = injectionByToolUse.get(row.tool_call_id)
      if (pending && pending.length > 0) {
        output.push({ ...(message as object), content: appendTextToContent(row.content, renderInjectionEntries(pending)) } as T)
      } else {
        output.push(message)
      }
      continue
    }

    if (!mayContainInjection(row.content_blocks)) {
      output.push(message)
      continue
    }
    const blocks = parseBlocks(row.content_blocks)
    if (!blocks || !blocks.some(isContextInjectionBlock)) {
      output.push(message)
      continue
    }

    const wasString = typeof row.content_blocks === 'string'
    const injections = blocks.filter(isContextInjectionBlock)
    const remaining = blocks.filter(block => !isContextInjectionBlock(block))

    if (row.role === 'user' || row.role === 'system') {
      const text = renderInjectionEntries(injections)
      output.push({
        ...(message as object),
        content: appendTextToContent(row.content, text),
        content_blocks: wasString ? JSON.stringify(remaining) : remaining,
      } as T)
      continue
    }

    // Assistant row: attach to tool results by id.
    const grouped = new Map<string, ContextInjectionEntry[]>()
    const orphans: ContextInjectionEntry[] = []
    for (const block of injections) {
      const entry: ContextInjectionEntry = { path: block.path, label: block.label, text: block.text, reason: block.reason }
      if (block.tool_use_id) {
        const list = grouped.get(block.tool_use_id) ?? []
        list.push(entry)
        grouped.set(block.tool_use_id, list)
      } else {
        orphans.push(entry)
      }
    }
    const toolResultIndexes = remaining
      .map((block, index) => ({ block: block as { type?: unknown; tool_use_id?: unknown }, index }))
      .filter(item => item.block?.type === 'tool_result')
    if (orphans.length > 0 && toolResultIndexes.length > 0) {
      const last = toolResultIndexes[toolResultIndexes.length - 1].block
      const id = typeof last.tool_use_id === 'string' ? last.tool_use_id : ''
      const list = grouped.get(id) ?? []
      list.push(...orphans)
      grouped.set(id, list)
    }
    const folded = remaining.map(block => {
      const candidate = block as { type?: unknown; tool_use_id?: unknown; content?: unknown }
      if (candidate?.type !== 'tool_result') return block
      const id = typeof candidate.tool_use_id === 'string' ? candidate.tool_use_id : ''
      const entries = grouped.get(id)
      if (!entries || entries.length === 0) return block
      return { ...(block as object), content: appendTextToContent(candidate.content, renderInjectionEntries(entries)) }
    })
    for (const [id, entries] of grouped) {
      if (!id) continue
      const existing = injectionByToolUse.get(id) ?? []
      injectionByToolUse.set(id, [...existing, ...entries])
    }
    output.push({ ...(message as object), content_blocks: wasString ? JSON.stringify(folded) : folded } as T)
  }

  return output
}

/** Build the persisted block for one injected entry. */
export function toContextInjectionBlock(entry: ContextInjectionEntry, toolUseId?: string | null): ContextInjectionBlock {
  return {
    type: CONTEXT_INJECTION_BLOCK_TYPE,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    path: entry.path,
    label: entry.label,
    text: entry.text,
    reason: entry.reason,
  }
}
