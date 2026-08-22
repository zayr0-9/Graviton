import fs from 'fs'
import os from 'os'
import path from 'path'
import { runBashCommand } from '../tools/bash.js'
import { isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'
import { ensureManagedHooksInitialized } from './hookStorage.js'
import type {
  HookEventName,
  HookExecutionMode,
  HookRunRequest,
  HookRunResult,
  NormalizedHookEntry,
  NormalizedHookHandler,
} from './hookTypes.js'

const YGG_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const
const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const DEFAULT_HOOK_MAX_OUTPUT_CHARS = 60_000

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

// Async hooks are fire-and-forget. Their output is logged but cannot affect the
// current request. Use sync for hooks that block, mutate prompts, update tool
// inputs, or provide immediate context.
function launchAsyncCommandHook(handler: NormalizedHookHandler, req: HookRunRequest): void {
  logHookRunner('launching async command hook', {
    event: req.event,
    command: handler.command,
    cwd: handler.workingDirectory || req.cwd || null,
    timeoutMs: handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  })

  void executeCommandHook(handler, req)
    .then(decision => {
      logHookRunner('async command hook completed', {
        event: req.event,
        command: handler.command,
        decisionKeys: Object.keys(decision),
        ignoredDecision: Object.keys(decision).length > 0,
      })
    })
    .catch(error => {
      warnHookRunner('async command hook failed', {
        event: req.event,
        command: handler.command,
        cwd: handler.workingDirectory || req.cwd || null,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

async function executeCommandHook(handler: NormalizedHookHandler, req: HookRunRequest): Promise<Partial<HookRunResult>> {
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

  const combinedOutput = [executionResult.stdout, executionResult.stderr].filter(Boolean).join('\n').trim()
  if (!combinedOutput) {
    if (!executionResult.success) {
      throw new Error(executionResult.error || 'Hook command failed without output')
    }
    return {}
  }

  try {
    const decision = normalizeDecision(req.event, JSON.parse(combinedOutput))
    logHookRunner('parsed command hook JSON output', {
      event: req.event,
      command: executedCommand,
      configuredCommand: handler.command,
      decisionKeys: Object.keys(decision),
      additionalContextPreview: previewForHookLog(decision.additionalContext),
    })
    return decision
  } catch {
    const interpreted = interpretTextResult(req.event, combinedOutput)
    logHookRunner('interpreted command hook text output', {
      event: req.event,
      command: executedCommand,
      configuredCommand: handler.command,
      interpretedKeys: Object.keys(interpreted),
      outputPreview: previewForHookLog(combinedOutput),
    })
    if (!executionResult.success && !interpreted.blocked && !interpreted.permissionDecision) {
      throw new Error(combinedOutput)
    }
    return interpreted
  }
}

export async function runHookRequest(req: HookRunRequest): Promise<HookRunResult> {
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
  const syncHandlers = handlersWithExecutionMode.filter(item => item.executionMode === 'sync').map(item => item.handler)
  const asyncHandlers = handlersWithExecutionMode.filter(item => item.executionMode === 'async').map(item => item.handler)

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
  }
  const additionalContexts: string[] = []

  for (const handler of asyncHandlers) {
    launchAsyncCommandHook(handler, req)
    result.launchedAsyncHookCount = (result.launchedAsyncHookCount ?? 0) + 1
  }

  for (const handler of syncHandlers) {
    try {
      const decision = await executeCommandHook(handler, req)
      result.hookCount += 1
      result = mergeHookDecision(result, req.event, decision, additionalContexts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnHookRunner('command hook failed', {
        event: req.event,
        command: handler.command,
        cwd: handler.workingDirectory || req.cwd || null,
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
