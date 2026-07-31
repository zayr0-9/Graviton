/**
 * buildServerLoopRequest — pure builder for the headless chat request (Phase 1).
 *
 * Returns the relative headless route `path` (resolved to the local server origin
 * by runServerChatLoop via buildLocalApiUrl) and the JSON `body`. Reuses values
 * already resolved inside the sendMessage/edit/branch thunks, so the shim just
 * forwards its locals.
 *
 * Notes / invariants (see Phase 1 spec):
 * - MUST send provider ('lmstudio'|'zai') and modelName, or the server silently
 *   defaults to openaichatgpt / gpt-5.6-sol.
 * - `content` is the RAW first-turn user text; the server owns the multi-turn loop.
 * - systemPrompt is intentionally OMITTED: the server assembles it from
 *   operationMode + project/conversation prompts. Sending buildOperationModeSystemPrompt
 *   output while also sending operationMode would double-wrap the mode instructions.
 * - attachmentsBase64 is turn-1 only (sent once on the initial request).
 */

export type ServerLoopOperation = 'send' | 'edit' | 'branch'

export interface ServerLoopToolInput {
  name: string
  description?: string
  inputSchema?: Record<string, any>
  enabled?: boolean
}

export interface BuildServerLoopRequestParams {
  conversationId: string
  /** send/branch: the raw user text; edit: the new content. */
  content: string
  provider: string
  modelName?: string
  userId?: string | null
  /** send: post-compaction parent; branch: parentId; edit: originalMessage.parent_id. */
  parentId?: string | null
  /** branch: the message branched FROM; edit: the message being edited. Required for those ops. */
  messageId?: string | null
  operationMode: 'plan' | 'execute'
  think?: boolean
  reasoningConfig?: unknown
  imageConfig?: unknown
  rootPath?: string | null
  conversationContext?: string | null
  projectContext?: string | null
  storageMode?: string
  attachmentsBase64?: unknown[] | null
  selectedFiles?: unknown[]
  tools?: ServerLoopToolInput[]
  streamId: string
  /**
   * Interactive tool-permission policy. Forwarded VERBATIM (never coerced): true =
   * auto-approve; false = server pauses per tool for a permission decision; undefined =
   * server default (auto-approve). The 3 shims pass state.chat.toolAutoApprove (a boolean).
   */
  toolAutoApprove?: boolean
}

export interface ServerLoopRequest {
  path: string
  body: Record<string, unknown>
}

function shapeTools(tools?: ServerLoopToolInput[]): Array<{ name: string; description?: string; inputSchema: Record<string, any> }> | undefined {
  // undefined => caller omitted tools => let the server use its default set.
  // A provided array (even all-disabled -> []) is authoritative: send it verbatim so
  // the server does NOT substitute defaults and auto-run tools the user disabled.
  if (!Array.isArray(tools)) return undefined
  return tools
    .filter(t => t.enabled !== false)
    .map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }))
}

export function buildServerLoopRequest(operation: ServerLoopOperation, params: BuildServerLoopRequestParams): ServerLoopRequest {
  const { conversationId } = params

  let path: string
  if (operation === 'send') {
    path = `/conversations/${conversationId}/messages`
  } else if (operation === 'branch') {
    if (!params.messageId) throw new Error('branch requires messageId (the message branched from)')
    path = `/conversations/${conversationId}/messages/${params.messageId}/branch`
  } else {
    if (!params.messageId) throw new Error('edit requires messageId (the message being edited)')
    path = `/conversations/${conversationId}/messages/${params.messageId}/edit-branch`
  }

  const tools = shapeTools(params.tools)

  const body: Record<string, unknown> = {
    content: params.content,
    provider: params.provider,
    modelName: params.modelName,
    userId: params.userId ?? null,
    parentId: params.parentId ?? null,
    operationMode: params.operationMode,
    includeOperationModePrompt: true,
    think: params.think,
    reasoningConfig: params.reasoningConfig,
    imageConfig: params.imageConfig,
    rootPath: params.rootPath ?? null,
    cwd: params.rootPath ?? null,
    conversationContext: params.conversationContext ?? null,
    projectContext: params.projectContext ?? null,
    storageMode: params.storageMode ?? 'local',
    selectedFiles: params.selectedFiles ?? [],
    attachmentsBase64: params.attachmentsBase64 ?? null,
    streamId: params.streamId,
    // Forward verbatim (no undefined -> false coercion): drives the server's pause gate.
    toolAutoApprove: params.toolAutoApprove,
  }
  // Send the tools array whenever the caller provided one (even []), so an
  // all-disabled set is respected; omit only when tools were not provided.
  if (tools !== undefined) body.tools = tools

  return { path, body }
}
