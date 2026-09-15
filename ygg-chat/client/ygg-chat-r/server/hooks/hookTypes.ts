export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  /** Fired when a branch gets its launch-time instruction set (`source: startup`) or after compaction (`source: compact`). */
  | 'SessionStart'
  /** Fired before an automatic compaction (`trigger: auto`). */
  | 'PreCompact'
  /** Fired when instruction files, rules or skills are injected (`load_reason`). */
  | 'InstructionsLoaded'

export type InstructionsLoadReason = 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact'
export type HookExecutionMode = 'sync' | 'async'

export interface HookToolCall {
  id?: string | null
  name?: string | null
  arguments?: any
  [key: string]: unknown
}

export interface HookLineage {
  rootMessageId?: string | null
  ancestorIds?: string[]
  depth?: number | null
  isRoot?: boolean
}

export interface HookLookup {
  localApiBase?: string | null
}

export interface HookTurnContext {
  lastUserMessageId?: string | null
  lastAssistantMessageId?: string | null
}

export interface HookProjectContext {
  projectId?: string | null
  projectName?: string | null
}

export interface HookRunRequest {
  event: HookEventName
  conversationId?: string | null
  streamId?: string | null
  cwd?: string | null
  provider?: string | null
  model?: string | null
  operation?: string | null
  prompt?: string | null
  toolCall?: HookToolCall | null
  toolResult?: any
  error?: string | null
  lastAssistantMessage?: string | null
  messageId?: string | null
  parentId?: string | null
  lineage?: HookLineage | null
  lookup?: HookLookup | null
  turn?: HookTurnContext | null
  project?: HookProjectContext | null
  /** SessionStart matcher value: `startup` | `compact`. */
  source?: string | null
  /** PreCompact matcher value: `auto` | `manual`. */
  trigger?: string | null
  /** InstructionsLoaded: matcher value plus the files that loaded. */
  loadReason?: InstructionsLoadReason | null
  filePaths?: string[] | null
}

export interface HookRunResult {
  matched: boolean
  hookCount: number
  blocked?: boolean
  reason?: string
  updatedPrompt?: string
  updatedInput?: Record<string, unknown>
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  additionalContext?: string
  errors?: string[]
  asyncHookCount?: number
  launchedAsyncHookCount?: number
}

export interface NormalizedHookHandler {
  type: 'command'
  command: string
  timeoutMs?: number
  matcher?: string | string[]
  workingDirectory?: string
  enabled?: boolean
  executionMode?: HookExecutionMode
}

export interface NormalizedHookEntry {
  matcher?: string | string[]
  handlers: NormalizedHookHandler[]
  source: string
}
