import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { runBashCommand } from '../tools/bash.js'
import { isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'
import { ensureManagedHooksInitialized, getManagedHooksDirectory } from './hookStorage.js'
import { appendHookTransition, redactHookDiagnostic, resolveHookLogTarget, toSafeHookRunRecord } from './hookDiagnostics.js'
import type {
  HookEventName,
  HookExecutionMode,
  HookRunRecord,
  HookRunStatus,
  HookScope,
  HookRunRequest,
  HookRunResult,
  NormalizedHookEntry,
  NormalizedHookHandler,
} from './hookTypes.js'

const YGG_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const
const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const DEFAULT_HOOK_MAX_OUTPUT_CHARS = 60_000
let defaultHookRunTracker: import('./hookTypes.js').HookRunTracker | null = null

export function configureHookRunTracker(tracker: import('./hookTypes.js').HookRunTracker | null): void {
  defaultHookRunTracker = tracker
}

function isHookDebugLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_HOOK_DEBUG_LOGS || '')
}

function previewForHookLog(value: unknown, maxLength = 800): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...<truncated:${raw.length}>` : raw
}

function logHookRunner(message: string, details?: Record<string, unknown>): void {
  if (!isHookDebugLoggingEnabled()) return
  console.info(`[HookRunner] ${message}`, details || {})
}

function warnHookRunner(message: string, details?: Record<string, unknown>): void {
  if (!isHookDebugLoggingEnabled()) return
  console.warn(`[HookRunner] ${message}`, details || {})
}

type HookCommandExecutionResult = Awaited<ReturnType<typeof runBashCommand>>

type HookCommandReport = {
  decision: Partial<HookRunResult>
  configuredCommand: string
  executedCommand: string
  cwd: string | null
  success: boolean
  timedOut: boolean
  fallbackAttempted: boolean
  error: string | null
  stdout: string
  stderr: string
  outcomeCode: string | null
  outcomeSummary: string | null
}

function deriveHookLabel(command: string): string {
  const scriptMatch = command.match(/(?:^|\s)([^\s"']+\.(?:py|js|mjs|cjs|sh))(?:\s|$)/i)
  const candidate = scriptMatch?.[1] || command.trim().split(/\s+/).at(-1) || 'hook'
  return path.basename(candidate).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
}

function deriveHookScope(sourceFile: string, requestCwd?: string | null): HookScope {
  const resolvedSource = path.resolve(sourceFile)
  const managedRoot = path.resolve(getManagedHooksDirectory())
  if (resolvedSource === managedRoot || resolvedSource.startsWith(`${managedRoot}${path.sep}`)) return 'personal'
  const cwd = typeof requestCwd === 'string' && requestCwd.trim() ? path.resolve(requestCwd) : null
  if (cwd && (resolvedSource === cwd || resolvedSource.startsWith(`${cwd}${path.sep}`))) {
    return path.basename(sourceFile) === 'settings.local.json' ? 'local_override' : 'project'
  }
  return path.basename(sourceFile) === 'settings.local.json' ? 'local_override' : 'project'
}

function parseHookOutcome(stdout: string): { code: string | null; summary: string | null } {
  const trimmed = stdout.trim()
  if (!trimmed) return { code: null, summary: null }
  try {
    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) return { code: null, summary: null }
    return {
      code: toTrimmedString(parsed.outcomeCode) ?? toTrimmedString(parsed.outcome_code),
      summary: toTrimmedString(parsed.outcomeSummary) ?? toTrimmedString(parsed.outcome_summary) ?? toTrimmedString(parsed.reason),
    }
  } catch {
    return { code: null, summary: null }
  }
}

function isSkippedOutcome(code: string | null): boolean {
  return Boolean(code && /^(unchanged|no_|missing_|messages_unavailable|disabled|empty_|not_)/.test(code))
}

function getPythonFallbackCommand(command: string): string | null {
  const trimmed = command.trimStart()
  const leadingWhitespace = command.slice(0, command.length - trimmed.length)
  if (trimmed.startsWith('python3 ')) return `${leadingWhitespace}python ${trimmed.slice('python3 '.length)}`
  if (trimmed.startsWith('python ')) return `${leadingWhitespace}python3 ${trimmed.slice('python '.length)}`
  return null
}

function isMissingPythonInterpreter(result: HookCommandExecutionResult): boolean {
  const combined = `${result.error || ''}\n${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase()
  return (
    /(^|\s)(python3?|\/usr\/bin\/env:\s*['"]?python3?)[:\s]/i.test(combined) &&
    /(command not found|no such file or directory|not found)/i.test(combined)
  )
}

async function runHookCommandWithPythonFallback(params: {
  command: string
  cwd?: string
  input: string
  timeoutMs: number
  maxOutputChars: number
}): Promise<{ executionResult: HookCommandExecutionResult; command: string; fallbackAttempted: boolean }> {
  const first = await runBashCommand(params.command, {
    cwd: params.cwd,
    input: params.input,
    timeoutMs: params.timeoutMs,
    maxOutputChars: params.maxOutputChars,
  })

  const fallbackCommand = getPythonFallbackCommand(params.command)
  if (first.success || !fallbackCommand || !isMissingPythonInterpreter(first)) {
    return { executionResult: first, command: params.command, fallbackAttempted: false }
  }

  warnHookRunner('python interpreter missing; retrying hook with fallback interpreter', {
    command: params.command,
    fallbackCommand,
    cwd: params.cwd,
    error: first.error || null,
    stderrPreview: previewForHookLog(first.stderr),
  })

  const second = await runBashCommand(fallbackCommand, {
    cwd: params.cwd,
    input: params.input,
    timeoutMs: params.timeoutMs,
    maxOutputChars: params.maxOutputChars,
  })

  return { executionResult: second, command: fallbackCommand, fallbackAttempted: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value)
  }
}

function parseExecutionMode(value: unknown): HookExecutionMode | undefined {
  const mode = toTrimmedString(value)?.toLowerCase()
  return mode === 'sync' || mode === 'async' ? mode : undefined
}

function getDefaultExecutionMode(event: HookEventName): HookExecutionMode {
  // Context-producing lifecycle events must be awaited or their stdout is lost.
  if (event === 'SessionStart' || event === 'PreCompact') return 'sync'
  // Hooks that can affect current prompt/tool decisions must remain synchronous by default.
  if (event === 'UserPromptSubmit' || event === 'PreToolUse') return 'sync'
  return 'async'
}

function resolveExecutionMode(event: HookEventName, handler: NormalizedHookHandler): HookExecutionMode {
  // PreToolUse is security/permission-sensitive; force it synchronous even if misconfigured.
  if (event === 'PreToolUse') return 'sync'
  return handler.executionMode ?? getDefaultExecutionMode(event)
}

function appendAdditionalContext(target: string[], value: unknown): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  target.push(trimmed)
}

function splitMatchers(matcher: string): string[] {
  return matcher
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesSinglePattern(pattern: string, candidate: string): boolean {
  if (!pattern || pattern === '*') return true

  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i').test(candidate)
    } catch {
      return false
    }
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    const regex = new RegExp(
      `^${pattern
        .split('')
        .map(char => {
          if (char === '*') return '.*'
          if (char === '?') return '.'
          return escapeRegex(char)
        })
        .join('')}$`,
      'i'
    )
    return regex.test(candidate)
  }

  return candidate.toLowerCase() === pattern.toLowerCase()
}

function matchesHookMatcher(event: HookEventName, matcher: string | string[] | undefined, req: HookRunRequest): boolean {
  if (!matcher) return true
  // Events without a tool use their own matcher vocabulary (docs §9.2):
  // SessionStart: startup|compact; PreCompact: auto|manual; InstructionsLoaded: load reasons.
  const eventValue =
    event === 'SessionStart' ? req.source : event === 'PreCompact' ? req.trigger : event === 'InstructionsLoaded' ? req.loadReason : null
  if (eventValue !== null) {
    const candidates = Array.isArray(matcher) ? matcher : splitMatchers(matcher)
    if (candidates.length === 0) return true
    const value = typeof eventValue === 'string' ? eventValue : ''
    return candidates.some(pattern => matchesSinglePattern(pattern, value))
  }
  if (event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'PostToolUseFailure') {
    return true
  }

  const toolName = typeof req.toolCall?.name === 'string' ? req.toolCall.name.trim() : ''
  if (!toolName) return false

  const candidates = Array.isArray(matcher) ? matcher : splitMatchers(matcher)
  if (candidates.length === 0) return true

  return candidates.some(pattern => matchesSinglePattern(pattern, toolName))
}

function normalizeHandler(
  rawHandler: unknown,
  fallbackMatcher: string | string[] | undefined,
  fallbackEnabled = true
): NormalizedHookHandler[] {
  if (!isRecord(rawHandler)) return []

  const isEnabled = fallbackEnabled && rawHandler.enabled !== false
  const nestedHandlers = Array.isArray(rawHandler.hooks) ? rawHandler.hooks : null
  const nestedMatcher = rawHandler.matcher as string | string[] | undefined
  if (nestedHandlers) {
    return nestedHandlers.flatMap(handler => normalizeHandler(handler, nestedMatcher ?? fallbackMatcher, isEnabled))
  }

  const command = toTrimmedString(rawHandler.command)
  const type = toTrimmedString(rawHandler.type)?.toLowerCase() ?? (command ? 'command' : null)
  if (type !== 'command' || !command) return []

  const timeoutMs = typeof rawHandler.timeoutMs === 'number' ? rawHandler.timeoutMs : undefined
  const matcher = (rawHandler.matcher as string | string[] | undefined) ?? fallbackMatcher
  const executionMode = parseExecutionMode(rawHandler.executionMode)

  return [
    {
      type: 'command',
      command,
      timeoutMs,
      matcher,
      enabled: isEnabled,
      executionMode,
    },
  ]
}

function normalizeEventEntries(rawValue: unknown, source: string): NormalizedHookEntry[] {
  const rawEntries = Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue]
  const workingDirectory = path.dirname(path.dirname(source))
  const entries: NormalizedHookEntry[] = []

  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) continue
    const entryMatcher = rawEntry.matcher as string | string[] | undefined
    const handlers = normalizeHandler(rawEntry, entryMatcher, rawEntry.enabled !== false).map(handler => ({
      ...handler,
      workingDirectory,
      sourceFile: source,
      label: deriveHookLabel(handler.command),
    }))
    if (handlers.length === 0) continue
    entries.push({
      ...(entryMatcher !== undefined ? { matcher: entryMatcher } : {}),
      handlers,
      source,
    })
  }

  return entries
}

async function resolveConfigSearchCwd(cwd: string | null | undefined): Promise<string | null> {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : ''
  if (!trimmed) return null
  if (isWindows() && trimmed.startsWith('/')) {
    return await resolveToWindowsPath(trimmed)
  }
  return trimmed
}

async function collectYggSettingsFiles(startDir: string | null): Promise<string[]> {
  const files: string[] = []

  const managedHooksDir = await ensureManagedHooksInitialized()
  logHookRunner('collecting settings files', { startDir, managedHooksDir })
  for (const fileName of YGG_SETTINGS_FILES) {
    const candidate = path.join(managedHooksDir, fileName)
    try {
      await fs.promises.access(candidate, fs.constants.R_OK)
      files.push(candidate)
      logHookRunner('found managed settings file', { candidate })
    } catch {
      logHookRunner('managed settings file not readable', { candidate })
    }
  }

  if (files.length > 0) {
    logHookRunner('using managed settings files', { files })
    return files
  }

  const visited = new Set<string>()

  const visitChain = async (initialDir: string | null) => {
    if (!initialDir) return
    let currentDir = path.resolve(initialDir)

    while (!visited.has(currentDir)) {
      visited.add(currentDir)

      const yggDir = path.join(currentDir, '.ygg')
      for (const fileName of YGG_SETTINGS_FILES) {
        const candidate = path.join(yggDir, fileName)
        try {
          await fs.promises.access(candidate, fs.constants.R_OK)
          files.push(candidate)
          logHookRunner('found fallback settings file', { candidate })
        } catch {
          // ignore missing files
        }
      }

      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
    }
  }

  await visitChain(startDir)
  await visitChain(os.homedir())

  logHookRunner('finished collecting settings files', { startDir, files })
  return files
}

async function loadHookEntriesForEvent(event: HookEventName, cwd: string | null | undefined): Promise<NormalizedHookEntry[]> {
  const searchCwd = await resolveConfigSearchCwd(cwd)
  const settingsFiles = await collectYggSettingsFiles(searchCwd)
  const entries: NormalizedHookEntry[] = []
  logHookRunner('loading hook entries for event', { event, cwd, searchCwd, settingsFiles })

  for (const settingsFile of settingsFiles) {
    let raw: string | null = null
    try {
      raw = await fs.promises.readFile(settingsFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
        logHookRunner('settings file has no hooks object', { settingsFile })
        continue
      }
      const eventEntries = normalizeEventEntries(parsed.hooks[event], settingsFile)
      logHookRunner('loaded hook entries from settings file', {
        event,
        settingsFile,
        entryCount: eventEntries.length,
        handlerCount: eventEntries.reduce((sum, entry) => sum + entry.handlers.length, 0),
      })
      entries.push(...eventEntries)
    } catch (error) {
      const details = raw === null
        ? { settingsFile, error }
        : { settingsFile, byteLength: Buffer.byteLength(raw, 'utf8'), error }
      console.warn(`[HookRunner] Failed to load ${settingsFile}:`, details)
    }
  }

  logHookRunner('loaded hook entries summary', {
    event,
    entryCount: entries.length,
    handlerCount: entries.reduce((sum, entry) => sum + entry.handlers.length, 0),
  })
  return entries
}

function buildSessionId(req: HookRunRequest): string {
  const conversationPart = toTrimmedString(req.conversationId) ?? 'conversation'
  const streamPart = toTrimmedString(req.streamId)
  return streamPart ? `${conversationPart}:${streamPart}` : conversationPart
}

function buildHookPayload(req: HookRunRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: buildSessionId(req),
    conversation_id: req.conversationId ?? null,
    cwd: req.cwd ?? process.cwd(),
    permission_mode: 'default',
    hook_event_name: req.event,
    message_id: req.messageId ?? null,
    parent_id: req.parentId ?? null,
  }

  if (req.lineage) {
    payload.lineage = {
      root_message_id: req.lineage.rootMessageId ?? null,
      ancestor_ids: Array.isArray(req.lineage.ancestorIds) ? req.lineage.ancestorIds : [],
      depth: typeof req.lineage.depth === 'number' ? req.lineage.depth : null,
      is_root: req.lineage.isRoot === true,
    }
  }

  if (req.lookup) {
    payload.lookup = {
      local_api_base: req.lookup.localApiBase ?? null,
    }
  }

  if (req.turn) {
    payload.turn = {
      last_user_message_id: req.turn.lastUserMessageId ?? null,
      last_assistant_message_id: req.turn.lastAssistantMessageId ?? null,
    }
  }

  if (req.project) {
    payload.project = {
      project_id: req.project.projectId ?? null,
      project_name: req.project.projectName ?? null,
    }
    payload.project_id = req.project.projectId ?? null
    payload.project_name = req.project.projectName ?? null
  }

  if (req.operation) payload.operation = req.operation
  if (req.provider) payload.provider = req.provider
  if (req.model) payload.model = req.model
  if (req.prompt != null) payload.prompt = req.prompt
  if (req.lastAssistantMessage != null) payload.last_assistant_message = req.lastAssistantMessage

  if (req.toolCall) {
    payload.tool_use_id = req.toolCall.id ?? null
    payload.tool_name = req.toolCall.name ?? null
    payload.tool_input = req.toolCall.arguments ?? {}
  }

  if (req.toolResult !== undefined) payload.tool_result = req.toolResult
  if (req.error != null) payload.error = req.error
  if (req.source != null) payload.source = req.source
  if (req.trigger != null) payload.trigger = req.trigger
  if (req.loadReason != null) payload.load_reason = req.loadReason
  if (Array.isArray(req.filePaths)) payload.file_paths = req.filePaths

  return payload
}

function interpretTextResult(event: HookEventName, text: string): Partial<HookRunResult> {
  const trimmed = text.trim()
  if (!trimmed) return {}

  const blockedMatch = trimmed.match(/^(blocked?|deny)\s*:\s*(.+)$/i)
  if (blockedMatch) {
    const reason = blockedMatch[2].trim()
    if (event === 'PreToolUse') {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }
    }

    return {
      blocked: true,
      reason,
    }
  }

  const allowMatch = trimmed.match(/^(allow|ok)\b/i)
  if (allowMatch && event === 'PreToolUse') {
    return { permissionDecision: 'allow' }
  }

  return { additionalContext: trimmed }
}

function normalizeDecision(event: HookEventName, raw: unknown): Partial<HookRunResult> {
  if (!isRecord(raw)) {
    if (typeof raw === 'string') {
      return interpretTextResult(event, raw)
    }
    return {}
  }

  const result: Partial<HookRunResult> = {}
  const decision = toTrimmedString(raw.decision)?.toLowerCase() ?? null
  const reason = toTrimmedString(raw.reason) ?? toTrimmedString(raw.message) ?? undefined

  if (typeof raw.additionalContext === 'string') {
    result.additionalContext = raw.additionalContext
  }

  if (event === 'UserPromptSubmit') {
    if (typeof raw.updatedPrompt === 'string') result.updatedPrompt = raw.updatedPrompt
    if (raw.blocked === true || decision === 'block' || decision === 'deny') {
      result.blocked = true
      result.reason = reason
    }
  }

  if (event === 'PreToolUse') {
    const permissionDecision = toTrimmedString(raw.permissionDecision)?.toLowerCase() ?? decision
    if (permissionDecision === 'allow' || permissionDecision === 'deny' || permissionDecision === 'ask') {
      result.permissionDecision = permissionDecision
    }
    if (typeof raw.permissionDecisionReason === 'string') {
      result.permissionDecisionReason = raw.permissionDecisionReason
    } else if (reason) {
      result.permissionDecisionReason = reason
    }
    if (isRecord(raw.updatedInput)) {
      result.updatedInput = raw.updatedInput as Record<string, unknown>
    }
  }

  if (event === 'Stop') {
    const continueRequested = raw.continue === true || raw.stop === false
    if (raw.blocked === true || decision === 'block' || continueRequested) {
      result.blocked = true
      result.reason = reason
    }
  }

  return result
}

function mergeHookDecision(
  current: HookRunResult,
  event: HookEventName,
  decision: Partial<HookRunResult>,
  additionalContexts: string[]
): HookRunResult {
  const next: HookRunResult = { ...current }

  if (decision.updatedPrompt !== undefined) next.updatedPrompt = decision.updatedPrompt
  if (decision.updatedInput !== undefined) next.updatedInput = decision.updatedInput

  if (decision.permissionDecision === 'deny') {
    next.permissionDecision = 'deny'
  } else if (decision.permissionDecision === 'ask' && next.permissionDecision !== 'deny') {
    next.permissionDecision = 'ask'
  } else if (decision.permissionDecision === 'allow' && !next.permissionDecision) {
    next.permissionDecision = 'allow'
  }

  if (decision.permissionDecisionReason) {
    next.permissionDecisionReason = decision.permissionDecisionReason
  }

  if (decision.blocked) {
    next.blocked = true
    if (decision.reason) next.reason = decision.reason
  }

  appendAdditionalContext(additionalContexts, decision.additionalContext)
  if (additionalContexts.length > 0) {
    next.additionalContext = additionalContexts.join('\n\n')
  }

  if (event === 'PreToolUse' && next.permissionDecision === 'deny' && !next.permissionDecisionReason && next.reason) {
    next.permissionDecisionReason = next.reason
  }

  return next
}

function persistHookRun(req: HookRunRequest, record: HookRunRecord): HookRunRecord {
  if (!req.runTracker) return record
  try {
    return req.runTracker.create(record)
  } catch (error) {
    console.warn('[HookRunner] Failed to persist scheduled hook run:', redactHookDiagnostic(error instanceof Error ? error.message : error, 500))
    return record
  }
}

function updateHookRun(req: HookRunRequest, record: HookRunRecord, update: Partial<HookRunRecord>): HookRunRecord {
  const next = { ...record, ...update, updatedAt: update.updatedAt || new Date().toISOString() }
  if (!req.runTracker) return next
  try {
    return req.runTracker.update(record.id, update) ?? next
  } catch (error) {
    console.warn('[HookRunner] Failed to update hook run:', redactHookDiagnostic(error instanceof Error ? error.message : error, 500))
    return next
  }
}

function toLogTransition(record: HookRunRecord) {
  return {
    runId: record.id,
    status: record.status,
    timestamp: record.updatedAt,
    event: record.event,
    conversationId: record.conversationId,
    streamId: record.streamId,
    messageId: record.messageId,
    label: record.label,
    scope: record.scope,
    executionMode: record.executionMode,
    configuredCommand: record.configuredCommand,
    executedCommand: record.executedCommand,
    sourceFile: record.sourceFile,
    cwd: record.cwd,
    durationMs: record.durationMs,
    outcomeCode: record.outcomeCode,
    outcomeSummary: record.outcomeSummary,
    errorSummary: record.errorSummary,
    stdoutPreview: record.stdoutPreview,
    stderrPreview: record.stderrPreview,
    logPath: record.logPath || '',
    logFallback: record.logFallback,
  }
}

async function executeTrackedHook(
  handler: NormalizedHookHandler,
  req: HookRunRequest,
  initialRecord: HookRunRecord
): Promise<{ report: HookCommandReport; record: HookRunRecord }> {
  const startedAt = new Date().toISOString()
  let record = updateHookRun(req, initialRecord, { status: 'running', startedAt, updatedAt: startedAt })
  await appendHookTransition(toLogTransition(record))
  const report = await executeCommandHook(handler, req)
  const completedAt = new Date().toISOString()
  const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
  const status: HookRunStatus = report.timedOut
    ? 'timed_out'
    : !report.success
      ? 'failed'
      : isSkippedOutcome(report.outcomeCode)
        ? 'skipped'
        : 'succeeded'
  record = updateHookRun(req, record, {
    status,
    completedAt,
    durationMs,
    executedCommand: redactHookDiagnostic(report.executedCommand, 2_000),
    outcomeCode: report.outcomeCode ?? (status === 'succeeded' ? 'completed' : status),
    outcomeSummary: report.outcomeSummary ?? (status === 'succeeded' ? 'completed' : report.error),
    errorSummary: status === 'failed' || status === 'timed_out' ? redactHookDiagnostic(report.error, 2_000) : null,
    stdoutPreview: redactHookDiagnostic(report.stdout),
    stderrPreview: redactHookDiagnostic(report.stderr),
    updatedAt: completedAt,
  })
  await appendHookTransition(toLogTransition(record))
  try { req.onActivity?.([toSafeHookRunRecord(record)]) } catch { /* terminal activity is best effort */ }
  return { report, record }
}

// Async hooks remain fire-and-forget for chat responsiveness, but their durable run
// record and NDJSON transition continue to terminal state after the chat SSE ends.
function launchAsyncCommandHook(handler: NormalizedHookHandler, req: HookRunRequest, record: HookRunRecord): void {
  void executeTrackedHook(handler, req, record).catch(async error => {
    const completedAt = new Date().toISOString()
    const failed = updateHookRun(req, record, {
      status: 'failed',
      completedAt,
      errorSummary: redactHookDiagnostic(error instanceof Error ? error.message : error, 2_000),
      outcomeCode: 'runner_error',
      outcomeSummary: 'Hook runner failed before command completion',
      updatedAt: completedAt,
    })
    await appendHookTransition(toLogTransition(failed))
    try { req.onActivity?.([toSafeHookRunRecord(failed)]) } catch { /* terminal activity is best effort */ }
    console.warn('[HookRunner] Async hook failed:', failed.errorSummary)
  })
}

async function executeCommandHook(handler: NormalizedHookHandler, req: HookRunRequest): Promise<HookCommandReport> {
  const payload = buildHookPayload(req)
  const cwd = handler.workingDirectory || req.cwd || undefined
  const timeoutMs = handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  logHookRunner('executing command hook', {
    event: req.event,
    command: handler.command,
    cwd,
    timeoutMs,
    conversationId: req.conversationId ?? null,
    messageId: req.messageId ?? null,
    parentId: req.parentId ?? null,
  })
  const commandInput = JSON.stringify(payload)
  const {
    executionResult,
    command: executedCommand,
    fallbackAttempted,
  } = await runHookCommandWithPythonFallback({
    command: handler.command,
    cwd,
    input: commandInput,
    timeoutMs,
    maxOutputChars: DEFAULT_HOOK_MAX_OUTPUT_CHARS,
  })

  logHookRunner('command hook completed', {
    event: req.event,
    command: handler.command,
    executedCommand,
    fallbackAttempted,
    cwd,
    success: executionResult.success,
    error: executionResult.error || null,
    stdoutPreview: previewForHookLog(executionResult.stdout),
    stderrPreview: previewForHookLog(executionResult.stderr),
  })

  const stdout = executionResult.stdout || ''
  const stderr = executionResult.stderr || ''
  const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim()
  let decision: Partial<HookRunResult> = {}
  if (combinedOutput) {
    try {
      decision = normalizeDecision(req.event, JSON.parse(stdout.trim() || combinedOutput))
    } catch {
      decision = interpretTextResult(req.event, combinedOutput)
    }
  }
  const outcome = parseHookOutcome(stdout)
  return {
    decision,
    configuredCommand: handler.command,
    executedCommand,
    cwd: cwd ?? null,
    success: executionResult.success,
    timedOut: executionResult.timedOut === true,
    fallbackAttempted,
    error: executionResult.error || (!executionResult.success ? combinedOutput || 'Hook command failed without output' : null),
    stdout,
    stderr,
    outcomeCode: outcome.code,
    outcomeSummary: outcome.summary,
  }
}

export async function runHookRequest(req: HookRunRequest): Promise<HookRunResult> {
  if (defaultHookRunTracker) req = { ...req, runTracker: defaultHookRunTracker }
  logHookRunner('run request start', {
    event: req.event,
    cwd: req.cwd ?? null,
    conversationId: req.conversationId ?? null,
    streamId: req.streamId ?? null,
    operation: req.operation ?? null,
    messageId: req.messageId ?? null,
    parentId: req.parentId ?? null,
  })
  const entries = await loadHookEntriesForEvent(req.event, req.cwd)
  const matchingHandlers = entries.flatMap(entry => {
    if (!matchesHookMatcher(req.event, entry.matcher, req)) return []
    return entry.handlers.filter(handler => handler.enabled !== false && matchesHookMatcher(req.event, handler.matcher, req))
  })

  const handlersWithExecutionMode = matchingHandlers.map(handler => ({
    handler,
    executionMode: resolveExecutionMode(req.event, handler),
  }))
  const syncHandlers = handlersWithExecutionMode.filter(item => item.executionMode === 'sync')
  const asyncHandlers = handlersWithExecutionMode.filter(item => item.executionMode === 'async')

  const logTarget = await resolveHookLogTarget(req.cwd).catch(() => ({
    logPath: path.join(getManagedHooksDirectory(), 'logs', 'hooks.ndjson'),
    fallback: true,
  }))
  const scheduledAt = new Date().toISOString()
  const scheduledRuns = handlersWithExecutionMode.map(({ handler, executionMode }): HookRunRecord =>
    persistHookRun(req, {
      id: uuidv4(),
      conversationId: req.conversationId ?? null,
      streamId: req.streamId ?? null,
      event: req.event,
      messageId: req.messageId ?? null,
      label: handler.label || deriveHookLabel(handler.command),
      configuredCommand: redactHookDiagnostic(handler.command, 2_000) || '',
      executedCommand: null,
      sourceFile: handler.sourceFile || '',
      scope: deriveHookScope(handler.sourceFile || '', req.cwd),
      executionMode,
      status: 'scheduled',
      outcomeCode: null,
      outcomeSummary: null,
      cwd: handler.workingDirectory || req.cwd || null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorSummary: null,
      stdoutPreview: null,
      stderrPreview: null,
      logPath: logTarget.logPath,
      logFallback: logTarget.fallback,
      createdAt: scheduledAt,
      updatedAt: scheduledAt,
    })
  )
  await Promise.all(scheduledRuns.map(run => appendHookTransition(toLogTransition(run))))
  if (scheduledRuns.length > 0) {
    try { req.onActivity?.(scheduledRuns.map(toSafeHookRunRecord)) } catch { /* activity must not break hooks */ }
  }

  logHookRunner('matched handlers', {
    event: req.event,
    entryCount: entries.length,
    handlerCount: matchingHandlers.length,
    syncHandlerCount: syncHandlers.length,
    asyncHandlerCount: asyncHandlers.length,
    handlers: handlersWithExecutionMode.map(({ handler, executionMode }) => ({
      command: handler.command,
      cwd: handler.workingDirectory || req.cwd || null,
      timeoutMs: handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      matcher: handler.matcher ?? null,
      configuredExecutionMode: handler.executionMode ?? null,
      executionMode,
    })),
  })

  let result: HookRunResult = {
    matched: matchingHandlers.length > 0,
    hookCount: 0,
    asyncHookCount: asyncHandlers.length,
    launchedAsyncHookCount: 0,
    errors: [],
    hookRuns: scheduledRuns.map(toSafeHookRunRecord),
  }
  const additionalContexts: string[] = []

  for (const item of asyncHandlers) {
    const runIndex = handlersWithExecutionMode.indexOf(item)
    launchAsyncCommandHook(item.handler, req, scheduledRuns[runIndex])
    result.launchedAsyncHookCount = (result.launchedAsyncHookCount ?? 0) + 1
  }

  for (const item of syncHandlers) {
    const runIndex = handlersWithExecutionMode.indexOf(item)
    try {
      const { report, record } = await executeTrackedHook(item.handler, req, scheduledRuns[runIndex])
      result.hookCount += 1
      result.hookRuns![runIndex] = toSafeHookRunRecord(record)
      if (!report.success) {
        pushUnique(result.errors || (result.errors = []), report.error || 'Hook command failed')
      } else {
        result = mergeHookDecision(result, req.event, report.decision, additionalContexts)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnHookRunner('command hook failed', {
        event: req.event,
        command: item.handler.command,
        cwd: item.handler.workingDirectory || req.cwd || null,
        error: message,
      })
      pushUnique(result.errors || (result.errors = []), message)
    }
  }

  if (!result.errors || result.errors.length === 0) {
    delete result.errors
  }

  logHookRunner('run request finished', {
    event: req.event,
    matched: result.matched,
    hookCount: result.hookCount,
    asyncHookCount: result.asyncHookCount ?? 0,
    launchedAsyncHookCount: result.launchedAsyncHookCount ?? 0,
    blocked: result.blocked ?? false,
    hasAdditionalContext: Boolean(result.additionalContext),
    errors: result.errors ?? [],
  })

  return result
}
