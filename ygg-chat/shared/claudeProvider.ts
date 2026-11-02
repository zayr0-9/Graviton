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

/** Claude's ultracode orchestration tool; its call launches a background workflow task. */
export const CLAUDE_WORKFLOW_TOOL = 'Workflow'

/** One agent of a running workflow, as its latest `workflow_progress` entry reports it. */
export interface ClaudeTaskAgent { label: string; phase?: string; state: string }
/**
 * A background task the main agent launched (a Workflow, a backgrounded Agent or Bash call),
 * kept on the tool_result of the call that launched it. Built from the SDK's task_* events.
 */
export interface ClaudeBackgroundTask {
  id: string
  /** The SDK task_type: local_workflow, local_agent, local_bash, ... */
  kind: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  description: string
  workflowName?: string
  /** What the task is doing now (a workflow's "phase: agent"); dropped once it ends. */
  activity?: string
  /** The CLI's completion summary. */
  summary?: string
  agents?: ClaudeTaskAgent[]
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
}
// A huge workflow must not grow its call's row without bound.
const MAX_TASK_AGENTS = 200
const TASK_STATUS: Record<string, ClaudeBackgroundTask['status']> = {
  pending: 'running', running: 'running', paused: 'running', completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped',
}
const taskUsage = (usage: any): ClaudeBackgroundTask['usage'] | undefined =>
  usage && Number.isFinite(usage.total_tokens)
    ? { totalTokens: usage.total_tokens, toolUses: Number(usage.tool_uses) || 0, durationMs: Number(usage.duration_ms) || 0 } : undefined

/** Agents keyed by their workflow ordinal; entries may repeat as an agent changes state. */
function mergeWorkflowAgents(agents: ClaudeTaskAgent[] | undefined, progress: unknown): ClaudeTaskAgent[] | undefined {
  if (!Array.isArray(progress)) return agents
  const byIndex = new Map<number, ClaudeTaskAgent>((agents ?? []).map((agent, index) => [index + 1, agent]))
  for (const item of progress) {
    if (item?.type !== 'workflow_agent' || !Number.isSafeInteger(item.index) || item.index < 1 || item.index > MAX_TASK_AGENTS) continue
    byIndex.set(item.index, {
      label: String(item.label ?? `agent ${item.index}`),
      ...(typeof item.phaseTitle === 'string' ? { phase: item.phaseTitle } : {}),
      state: String(item.state ?? 'start'),
    })
  }
  const merged = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, agent]) => agent)
  return merged.length ? merged : agents
}

const withoutActivity = (task: ClaudeBackgroundTask): ClaudeBackgroundTask => {
  const next = { ...task }
  delete next.activity
  return next
}

/** Folds one SDK task_* system event into a task's state; null for any other event. */
export function applyClaudeTaskEvent(task: ClaudeBackgroundTask | undefined, event: any): ClaudeBackgroundTask | null {
  const id = typeof event?.task_id === 'string' ? event.task_id : null
  if (!id || event.type !== 'system') return null
  const base: ClaudeBackgroundTask = task ?? { id, kind: 'task', status: 'running', description: String(event.description ?? '') }
  switch (event.subtype) {
    case 'task_started':
      return { ...base, kind: String(event.task_type ?? base.kind), description: String(event.description ?? base.description),
        ...(typeof event.workflow_name === 'string' ? { workflowName: event.workflow_name } : {}) }
    case 'task_progress': {
      if (base.status !== 'running') return base
      const agents = mergeWorkflowAgents(base.agents, event.workflow_progress)
      return { ...base, ...(typeof event.description === 'string' ? { activity: event.description } : {}),
        ...(agents ? { agents } : {}), ...(taskUsage(event.usage) ? { usage: taskUsage(event.usage) } : {}) }
    }
    case 'task_updated': {
      const status = TASK_STATUS[event.patch?.status] ?? base.status
      return { ...(status === 'running' ? base : withoutActivity(base)), status,
        ...(typeof event.patch?.description === 'string' ? { description: event.patch.description } : {}),
        ...(typeof event.patch?.error === 'string' && event.patch.error ? { summary: event.patch.error } : {}) }
    }
    case 'task_notification': {
      return { ...withoutActivity(base), status: TASK_STATUS[event.status] ?? 'completed',
        ...(typeof event.summary === 'string' && event.summary ? { summary: event.summary } : {}),
        ...(taskUsage(event.usage) ? { usage: taskUsage(event.usage) } : {}) }
    }
    default:
      return null
  }
}
