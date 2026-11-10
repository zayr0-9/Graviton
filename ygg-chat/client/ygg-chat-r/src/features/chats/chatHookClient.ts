import { localApi } from '../../utils/api'
import { isNativeShell } from '../../platform/clientCapabilities'

const isHookDebugLoggingEnabled = (): boolean => {
  try {
    return localStorage.getItem('chat:hookDebugLogs') === 'true'
  } catch {
    return false
  }
}

export interface ChatHookLineage {
  rootMessageId?: string | null
  ancestorIds?: string[]
  depth?: number | null
  isRoot?: boolean
}

export interface ChatHookLookup {
  localApiBase?: string | null
}

export interface ChatHookTurnContext {
  lastUserMessageId?: string | null
  lastAssistantMessageId?: string | null
}

export interface ChatHookProjectContext {
  projectId?: string | null
  projectName?: string | null
}

export type ChatHookEventName = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'

export interface ChatHookRequest {
  event: ChatHookEventName
  conversationId?: string | null
  streamId?: string | null
  cwd?: string | null
  provider?: string | null
  model?: string | null
  operation?: string | null
  prompt?: string | null
  toolCall?: any
  toolResult?: any
  error?: string | null
  lastAssistantMessage?: string | null
  messageId?: string | null
  parentId?: string | null
  lineage?: ChatHookLineage | null
  lookup?: ChatHookLookup | null
  turn?: ChatHookTurnContext | null
  project?: ChatHookProjectContext | null
}

export interface ChatHookResult {
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

export async function runChatHook(request: ChatHookRequest): Promise<ChatHookResult> {
  const isElectronMode = isNativeShell

  const isStopEvent = request.event === 'Stop'

  if (!isElectronMode) {
    if (isStopEvent) {
      console.warn('[chatHookClient][Stop] skipped: not in Electron mode', {
        buildTarget: typeof __BUILD_TARGET__ !== 'undefined' ? __BUILD_TARGET__ : null,
        isElectronGlobal: typeof __IS_ELECTRON__ !== 'undefined' ? __IS_ELECTRON__ : null,
      })
    }
    return { matched: false, hookCount: 0 }
  }

  try {
    const debugHooks = isHookDebugLoggingEnabled()

    if (isStopEvent || debugHooks) {
      console.debug('[chatHookClient] hook request', {
        conversationId: request.conversationId ?? null,
        operation: request.operation ?? null,
        messageId: request.messageId ?? null,
        parentId: request.parentId ?? null,
        lineage: request.lineage ?? null,
        turn: request.turn ?? null,
        project: request.project ?? null,
      })
    }

    const result = await localApi.post<ChatHookResult>('/hooks/run', request)

    if (isStopEvent || debugHooks || (Array.isArray(result.errors) && result.errors.length > 0)) {
      const log = Array.isArray(result.errors) && result.errors.length > 0 ? console.warn : console.info
      log('[chatHookClient] hook result', {
        event: request.event,
        matched: result.matched,
        hookCount: result.hookCount,
        asyncHookCount: result.asyncHookCount ?? 0,
        launchedAsyncHookCount: result.launchedAsyncHookCount ?? 0,
        blocked: result.blocked ?? false,
        reason: result.reason ?? null,
        additionalContext: result.additionalContext ?? null,
        errors: result.errors ?? [],
      })
    }

    return result
  } catch (error) {
    console.warn('[chatHookClient] Hook execution failed:', error, {
      event: request.event,
      conversationId: request.conversationId ?? null,
      turn: request.turn ?? null,
      lineage: request.lineage ?? null,
    })
    return {
      matched: false,
      hookCount: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }
}
