/** Claude sessions are a separate execution backend, not an API tool-loop provider. */
export const CLAUDE_PROVIDER = 'Claude Code'
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7'] as const
// Every supported Claude model has a 1M-token context window.
export const CLAUDE_CONTEXT_LENGTH = 1_000_000
export function isClaudeProvider(provider: unknown): boolean {
  return typeof provider === 'string' && ['claude', 'claudecode', 'anthropic(claudecli)'].includes(provider.toLowerCase().replace(/\s+/g, ''))
}
export function claudeMessageMetadata(meta: unknown): any {
  try {
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function isClaudeTranscriptMessage(message: { meta?: unknown } | null | undefined): boolean {
  const meta = claudeMessageMetadata(message?.meta)
  return Boolean(meta.claude || isClaudeProvider(meta.modelSelection?.provider))
}

export function isClaudeCheckpoint(message: { meta?: unknown } | null | undefined): boolean {
  return claudeMessageMetadata(message?.meta).claude?.checkpoint === true
}

/** `sourceFile` of a hook run Claude Code executed itself (its settings and plugins, not Graviton's `.ygg`). */
export const CLAUDE_NATIVE_HOOK_SOURCE = 'Claude Code'
export function isClaudeNativeHookRun(run: { sourceFile?: string | null } | null | undefined): boolean {
  return run?.sourceFile === CLAUDE_NATIVE_HOOK_SOURCE
}

/** One hunk of a native Edit/Write `structuredPatch`; `lines` carry ' ', '-' or '+' prefixes. */
export interface ClaudeFilePatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}
/** The renderable part of a native Edit/Write tool_use_result, kept on its tool_result block. */
export interface ClaudeFilePatch {
  filePath: string
  kind: 'edit' | 'create' | 'update'
  hunks: ClaudeFilePatchHunk[]
}
// Native file tools whose tool_use_result carries a structuredPatch.
export const CLAUDE_FILE_EDIT_TOOLS = new Set(['Edit', 'Write'])
// A whole-file Write can produce a huge patch; past this the args diff is drawn instead.
const MAX_PATCH_CHARS = 200_000

const isHunk = (value: any): value is ClaudeFilePatchHunk =>
  Boolean(value) && ['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isFinite(value[key])) &&
  Array.isArray(value.lines) && value.lines.every((line: unknown) => typeof line === 'string')

/** Keep only the hunks of FileEditOutput/FileWriteOutput; originalFile and content would bloat every row. */
export function claudeFilePatch(toolUseResult: unknown): ClaudeFilePatch | undefined {
  const result = toolUseResult as any
  if (!result || typeof result.filePath !== 'string' || !Array.isArray(result.structuredPatch)) return undefined
  const hunks: ClaudeFilePatchHunk[] = result.structuredPatch.filter(isHunk).map((hunk: ClaudeFilePatchHunk) => ({
    oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines,
  }))
  if (hunks.reduce((size, hunk) => size + hunk.lines.reduce((sum, line) => sum + line.length + 1, 0), 0) > MAX_PATCH_CHARS) return undefined
  const kind = result.type === 'create' || result.type === 'update' ? result.type : 'edit'
  return { filePath: result.filePath, kind, hunks }
}
