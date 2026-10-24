import { estimateTokenCount } from 'tokenx'

/** Appendix-only projections. Never mutate durable tool history or live tool results. */
type Policy = 'input' | 'file' | 'repl' | 'watcher' | 'link' | 'batch' | 'edits' | 'legacy' | number
export const COMPACTION_TOOL_POLICIES: Readonly<Record<string, Policy>> = {
  claude_bridge: 200,
  repl: 'repl',
  read_file: 'file', read_files: 'file', read_file_continuation: 'file',
  create_file: 'file', delete_file: 'file', edit_file: 'file', multi_edit: 'edits',
  watcher: 'watcher', fetch_chats: 'input', internalLink: 'link',
  multi_call: 'batch', brave_search: 'input', brave_web_search: 'input',
  ripgrep: 'input', glob: 'input', browse_web: 'input', custom_tool_manager: 'input',
  bash: 300, powershell: 300, mcp_manager: 300, skill_manager: 300,
  subagent_manager: 300, subagent: 300,
  html_renderer: 'legacy',
}
export const COMPACTION_APPENDIX_MAX_CHARS = 40000
const MAX_NESTING = 8
const FILE_INPUT_KEYS = ['path', 'paths', 'cwd', 'baseDir', 'operation', 'startLine', 'endLine', 'ranges',
  'afterLine', 'numLines', 'maxBytes', 'includeHash', 'approxStartLine', 'approxEndLine', 'createBackup',
  'encoding', 'validateContent', 'expectedHash', 'expectedMetadata', 'createParentDirs', 'overwrite',
  'executable', 'allowedExtensions']
const FILE_RESULT_KEYS = ['success', 'path', 'paths', 'filePath', 'operation', 'metadata', 'startLine', 'endLine',
  'ranges', 'nextLine', 'nextRangeIndex', 'partialLastLine', 'totalLines', 'linesRead', 'sizeBytes',
  'bytesRead', 'bytesWritten', 'contentHash', 'fileHash', 'truncated', 'returnedCount', 'omittedCount',
  'nextFileIndex', 'filesRead', 'filesEdited', 'replacements', 'replacementCount', 'created', 'deleted',
  'backupPath', 'backup', 'lineInfo', 'matchStrategy', 'attemptedStrategies', 'lineCount', 'errorCode', 'code']
const REPL_KEYS = ['action', 'tool', 'assign', 'variable', 'show', 'path', 'overwrite', 'offset', 'maxOutputChars']
const REPL_RESULT_KEYS = ['success', 'status', 'variable', 'resultVariable', 'toolStatus', 'revision',
  'lastWriter', 'metadataOnly', 'nextOffset', 'totalChars', 'truncated', 'path', 'snapshotRevision', 'dropped', 'reset', 'pendingCaptures']
const WATCH_KEYS = ['action', 'handle', 'kind', 'pid', 'path', 'pattern', 'regex', 'url', 'expectedStatus',
  'timeoutMs', 'checkIntervalMs', 'success', 'found', 'state', 'status', 'watchHandle', 'runId', 'sessionId',
  'streamId', 'autoResume', 'exitCode', 'errorCode', 'createdAt', 'completedAt', 'triggeredAt', 'delivery']
const PRIORITY_KEYS = ['success', 'status', 'state', 'action', 'handle', 'sessionId', 'name', 'jobId', 'runId',
  'streamId', 'watchHandle', 'autoResume', 'exitCode', 'timedOut', 'signal', 'nextOffset', 'offset',
  'truncated', 'errorCode', 'cancelled']

export const isCompactionRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function decodeCompactionResult(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
const serialize = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? ''
const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isCompactionRecord(value)) return {}
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}

/** Limits use the existing tokenx estimator, not a provider-specific tokenizer.
 * The marker is included in the budget; shell output retains both ends.
 */
export function truncateCompactionOutput(text: string, maxTokens: number, middle = false): string {
  if (estimateTokenCount(text) <= maxTokens) return text
  const marker = '\n...[output truncated]...\n'
  const candidate = (length: number) => middle
    ? text.slice(0, Math.ceil(length / 2)) + marker + text.slice(text.length - Math.floor(length / 2))
    : text.slice(0, length) + marker
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokenCount(candidate(mid)) <= maxTokens) low = mid
    else high = mid - 1
  }
  return candidate(low)
}

/** Execution outcome only: queried job/watch state is retained separately in output.
 * Never infer failure from arbitrary prose such as "0 tests failed".
 */
export function compactionToolStatus(result: unknown, isError?: boolean | null, name?: string): string {
  const value = decodeCompactionResult(result)
  if (isError === true) return 'failed'
  if (isCompactionRecord(value)) {
    if (value.skipped === true) return 'skipped'
    if ((name === 'bash' || name === 'powershell') && value.cancelled === true) return 'cancelled'
    if (name === 'multi_call' && Array.isArray(value.results)) {
      const failed = value.results.some(item => isCompactionRecord(item) && (item.ok === false ||
        compactionToolStatus(item.data, undefined, typeof item.tool === 'string' ? item.tool : undefined) === 'failed'))
      if (failed) return 'completed with child failures'
    }
    if (name === 'repl' && value.status === 'conflict') return 'conflict'
    if (name === 'repl' && value.toolStatus === 'error') return 'stored tool error'
    if (value.success === false || value.ok === false) return 'failed'
    if (name === 'read_files' && value.success === true) return 'completed; per-file outcomes omitted'
    if (value.success === true || value.ok === true) return 'success'
    if (name === 'bash' || name === 'powershell') {
      if (typeof value.exitCode === 'number') return value.exitCode === 0 ? 'success' : 'failed'
    }
  }
  if (isError === false) return 'success'
  return 'status unknown'
}

// Metadata allowlists prevent file text hidden in diagnostic/diff fields from being reintroduced.
function fileMetadata(value: unknown): unknown {
  const decoded = decodeCompactionResult(value)
  const kept = pick(decoded, FILE_RESULT_KEYS)
  if ((isCompactionRecord(decoded) && (decoded.error || decoded.success === false)) || typeof decoded === 'string') {
    kept.detail = 'File body/diagnostic text omitted; inspect original result for details.'
  }
  return kept
}

function boundedResult(value: unknown, limit: number, shell: boolean): string {
  const decoded = decodeCompactionResult(value)
  if (!isCompactionRecord(decoded)) return truncateCompactionOutput(serialize(decoded), limit, shell)
  const priority = pick(decoded, PRIORITY_KEYS)
  const rest = Object.fromEntries(Object.entries(decoded).filter(([key]) => !(key in priority)))
  const prefix = Object.keys(priority).length ? serialize(priority) + '\n' : ''
  // Apply one budget to all output, not separate budgets for each stream or field.
  const prefixTokens = estimateTokenCount(prefix)
  if (prefixTokens >= limit - 10) return truncateCompactionOutput(prefix, limit)
  const body = shell
    ? Object.entries(rest).map(([key, item]) => `${key}: ${serialize(item)}`).join('\n')
    : serialize(rest)
  const result = prefix + truncateCompactionOutput(body, limit - prefixTokens - 2, shell)
  return estimateTokenCount(result) <= limit ? result : truncateCompactionOutput(result, limit)
}

export interface CompactionToolProjection {
  input: unknown
  output?: unknown
}

export function projectCompactionTool(name: string, args: Record<string, unknown>, rawResult: unknown, depth = 0): CompactionToolProjection {
  if (depth >= MAX_NESTING) return { input: { omitted: 'nesting limit' } }
  const policy = COMPACTION_TOOL_POLICIES[name] ?? 300
  const result = decodeCompactionResult(rawResult)
  if (policy === 'input') return { input: args }
  if (policy === 'file') return {
    input: name === 'read_file' || name === 'read_files' || name === 'read_file_continuation' ? args : pick(args, FILE_INPUT_KEYS),
    output: fileMetadata(result),
  }
  if (policy === 'edits') {
    const results = isCompactionRecord(result) && Array.isArray(result.results) ? result.results : []
    return { input: pick(args, ['stopOnError', 'createBackup', 'encoding', 'validateContent']), output: {
      ...pick(result, ['success', 'applied', 'failed', 'stoppedEarly']),
      edits: (Array.isArray(args.edits) ? args.edits : []).map((edit, index) => ({
        index, ...projectCompactionTool('edit_file', isCompactionRecord(edit) ? edit : {}, results[index], depth + 1),
        status: compactionToolStatus(results[index]),
      })),
    } }
  }
  if (policy === 'batch') {
    const results = isCompactionRecord(result) && Array.isArray(result.results) ? result.results : []
    return { input: pick(args, ['parallel', 'maxConcurrency', 'stopOnError']), output: {
      ...pick(result, ['parallel', 'stopOnError']),
      calls: (Array.isArray(args.calls) ? args.calls : []).map((call, index) => {
        const child = isCompactionRecord(call) ? call : {}
        const childName = typeof child.tool === 'string' ? child.tool : typeof child.toolName === 'string' ? child.toolName : 'unknown'
        const receipt = isCompactionRecord(results[index]) ? results[index] : undefined
        // Missing/skipped children must not inherit a successful wrapper status.
        const output = receipt?.data ?? receipt?.result
        return { index, tool: childName, status: receipt?.skipped === true ? 'skipped' :
          compactionToolStatus(output, receipt?.ok === false ? true : receipt?.ok === true ? false : undefined, childName),
          ...projectCompactionTool(childName, isCompactionRecord(child.args) ? child.args : {}, output, depth + 1) }
      }),
    } }
  }
  if (policy === 'repl') {
    const input = pick(args, REPL_KEYS)
    if (args.action === 'invoke' && typeof args.tool === 'string') {
      input.invocation = projectCompactionTool(args.tool, isCompactionRecord(args.args) ? args.args : {}, undefined, depth + 1)
    }
    const output = pick(result, REPL_RESULT_KEYS)
    if (isCompactionRecord(result) && Array.isArray(result.variables)) {
      output.variables = result.variables.map(item => typeof item === 'string' ? item : pick(item, ['name', 'variable']))
    }
    return { input, output }
  }
  if (policy === 'watcher') {
    const output = pick(result, WATCH_KEYS)
    if (isCompactionRecord(result) && Array.isArray(result.watches)) output.watches = result.watches.map(item => pick(item, WATCH_KEYS))
    return { input: pick(args, WATCH_KEYS), output }
  }
  if (policy === 'link') return { input: args, output: {
    ...pick(result, ['success', 'route', 'url', 'href', 'path']),
    ...(isCompactionRecord(result) && isCompactionRecord(result.target)
      ? { target: pick(result.target, ['routeType', 'projectId', 'conversationId', 'messageId', 'route', 'canNavigate']) } : {}),
  } }
  if (policy === 'legacy') {
    const snippet = (value: unknown, maxChars: number) => {
      const normalized = (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '').replace(/\r\n/g, '\n').trim()
      if (normalized.length <= maxChars) return normalized
      const visible = normalized.slice(0, Math.max(0, maxChars - 18)).trimEnd()
      return `${visible}\n...[truncated ${normalized.length - visible.length} chars]`
    }
    return { input: snippet(args, 4000), output: snippet(rawResult, 8000) }
  }
  return { input: args, output: rawResult == null ? undefined : boundedResult(result, policy, name === 'bash' || name === 'powershell') }
}
