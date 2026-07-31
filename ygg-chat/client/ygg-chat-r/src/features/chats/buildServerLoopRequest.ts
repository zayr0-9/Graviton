/**
 * buildServerLoopRequest — pure builder for the headless chat request (Phase 1).
 *
 * Returns the relative headless route `path` (resolved to the local server origin
 * by runServerChatLoop via buildLocalApiUrl) and the JSON `body`. Reuses values
 * already resolved inside the sendMessage/edit/branch thunks, so the shim just
 * forwards its locals.
 *
 * Notes / invariants (see Phase 1 spec):
 * - MUST send provider ('lmstudio'|'zai'|'openrouter'|'openaichatgpt') and modelName,
 *   or the server silently defaults to openaichatgpt / gpt-5.6-sol.
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
  /**
   * Phase 3: opt into the server-owned loop's chat hooks (parity with the renderer's
   * always-on-in-electron hooks). The 3 shims pass isElectronMode. Forwarded verbatim.
   */
  hooksEnabled?: boolean
  /** Passed to hook scripts as lookup.localApiBase; the shims pass getCachedLocalApiBase(). */
  localApiBase?: string | null
  /**
   * Phase 4 (openrouter/cloud route): the resolved OpenRouter sampling temperature.
   * Undefined for lmstudio/zai (resolveOpenRouterTemperature returns undefined), so
   * it is omitted from those bodies — keeping the local-provider request unchanged.
   */
  temperature?: number
  /**
   * Phase 4 (openrouter/cloud route): the paid-tier service tier. The shims pass it
   * only for openrouter, so the lmstudio/zai body never gains this field.
   */
  serviceTier?: 'priority'
  /**
   * ChatGPT (openaichatgpt) auth, forwarded from the renderer's getValidTokens() so
   * the server's OpenAiChatgptProvider uses them directly instead of depending on its
   * token-store row. Forwarded only-when-set; the server also parses them from the
   * Authorization / ChatGPT-Account-Id headers, and falls back to its store otherwise.
   */
  accessToken?: string | null
  accountId?: string | null
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
    // Phase 3 hooks: forward verbatim. The server gates on `=== true`, so undefined = off.
    hooksEnabled: params.hooksEnabled,
    localApiBase: params.localApiBase ?? null,
  }
  // Send the tools array whenever the caller provided one (even []), so an
  // all-disabled set is respected; omit only when tools were not provided.
  if (tools !== undefined) body.tools = tools

  // Phase 4 openrouter parity: forward these only when set, so no undefined keys
  // reach the body and the lmstudio/zai request stays byte-for-byte unchanged.
  if (typeof params.temperature === 'number') body.temperature = params.temperature
  if (params.serviceTier !== undefined) body.serviceTier = params.serviceTier
  // ChatGPT auth: forward only-when-set so non-ChatGPT bodies are unchanged.
  if (params.accessToken) body.accessToken = params.accessToken
  if (params.accountId) body.accountId = params.accountId

  return { path, body }
}
