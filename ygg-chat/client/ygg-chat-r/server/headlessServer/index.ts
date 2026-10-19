import { registerHostAppBridgeRoutes } from '../routes/hostAppBridgeRoutes.js'
import { join } from 'node:path'
import { getServerTempDir } from '../serverHost.js'
import { configureSnapshotScratch, disposeSnapshotScratch } from './services/snapshotPayloadStore.js'
import { DecisionReceiptRepo } from './persistence/decisionReceiptRepo.js'
import { applyHostProviderEnvironment, readHostExecutionPreferences } from '../hostExecutionStore.js'
import { RunSnapshotProjector } from './services/runSnapshotProjector.js'
import { OperationReceiptRepo } from './persistence/operationReceiptRepo.js'
import { RunAdmissionService } from './services/runAdmissionService.js'
import { hostEpoch } from '../hostEpoch.js'
import { reconcileHeadlessRuns } from './persistence/reconcileHeadlessRuns.js'
import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { customToolRegistry } from '../tools/customToolLoader.js'
import { toolOrchestrator as defaultToolOrchestrator } from '../tools/orchestrator/index.js'
import { isBuiltInToolAvailable } from '../serverHost.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../shared/builtinToolDefinitions.js'
import { initializeAuth } from '../auth/runtime.js'
import { ProviderTokenStore } from './providers/tokenStore.js'
import { registerCapabilityRoutes } from './routes/capabilityRoutes.js'
import { registerChatRoutes, launchQueuedSuccessor } from './routes/chatRoutes.js'
import { registerCrudRoutes } from './routes/crudRoutes.js'
import { registerProviderAuthRoutes } from './routes/providerAuthRoutes.js'
import { registerMobileUiRoutes } from './routes/mobileUiRoutes.js'
import { registerHostRuntimeRoutes } from '../routes/hostRuntimeRoutes.js'
import { registerCustomToolsRoutes } from './routes/customToolsRoutes.js'
import { registerCustomToolRpcRoutes } from './routes/customToolRpcRoutes.js'
import { registerEphemeralGenerateRoutes } from './routes/ephemeralGenerateRoutes.js'
import { registerSubagentRoutes } from './routes/subagentRoutes.js'
import { registerTestHarnessRoutes } from './routes/testHarnessRoutes.js'
import { registerGatewayRoutes } from './routes/gatewayRoutes.js'
import { registerLineageRoutes } from './routes/lineageRoutes.js'
import { registerCloudProxyRoutes } from './routes/cloudProxyRoutes.js'
import { createAppAuthTokenManager } from './services/appAuthTokenManager.js'
import { createRailwayClient } from './services/railwayClient.js'
import { createCloudMirrorService } from './services/cloudMirrorService.js'
import { runHookRequest } from '../hooks/hookRunner.js'
import { ChatOrchestrator } from './services/chatOrchestrator.js'
import { DecisionBroker } from './services/decisionBroker.js'
import { RunSessionRegistry } from './services/runSessionRegistry.js'
import { SubagentRunService } from './services/subagentRunService.js'
import { createSubagentDispatchExecutor, createSubagentManagerExecutor } from './services/subagentToolExecutor.js'
import { claudeBridge } from '../tools/claudeBridge.js'
import { withToolAccess } from '../toolAccessContext.js'
import { createWatchExecutor, watchService } from './services/watchService.js'
import { createMultiCallDispatchExecutor } from './services/multiCallExecutor.js'
import { createReplDispatchExecutor } from './services/replExecutor.js'
import { createContextStatusExecutor } from './services/contextStatusTool.js'
import { ProviderRouter, normalizeProviderRoute } from './services/providerRouter.js'
import { resolveGatewayFlags } from './config/gatewayFlags.js'
import type { ToolExecutor } from './services/toolLoopService.js'

type OrchestratorLike = typeof defaultToolOrchestrator

interface HeadlessServerRouteDeps {
  db: Database.Database
  statements: any
  /**
   * Tool orchestrator owning submit/poll/cancel. The composition root
   * (localServer.ts) injects the instance it registered tools on; the default
   * keeps legacy behavior for tests that register routes directly.
   */
  orchestrator?: OrchestratorLike
}

type InferenceToolDefinition = {
  name: string
  description?: string
  inputSchema?: Record<string, any>
  serverName?: string
  toolName?: string
  ui?: {
    resourceUri?: string
    visibility?: Array<'model' | 'app'>
  }
}

const HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES = new Set([
  'claude_bridge',
  'todo_list',
  'plan_md',
  'fetch_notes',
  'fetch_chats',
  'context_status',
  'read_file',
  'read_file_continuation',
  'read_files',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'directory',
  'glob',
  'ripgrep',
  'brave_search',
  'browse_web',
  'bash',
  'powershell',
  'html_renderer',
  'theme_manager',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
  'subagent',
  'subagent_manager',
  'watcher',
  'repl',
  'multi_call',
])

// Computed per call: host-gated tools (e.g. browse_web without a browser
// engine) are resolved during server startup, after this module loads.
const getBuiltInInferenceTools = (): InferenceToolDefinition[] =>
  BUILTIN_TOOL_DEFINITIONS.filter(
    tool => HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES.has(tool.name) && isBuiltInToolAvailable(tool.name)
  ).map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))

const dedupeToolsByName = (tools: InferenceToolDefinition[]): InferenceToolDefinition[] => {
  const byName = new Map<string, InferenceToolDefinition>()
  for (const tool of tools) {
    if (!tool?.name) continue
    if (!byName.has(tool.name)) {
      byName.set(tool.name, tool)
    }
  }
  return Array.from(byName.values())
}

const resolveDefaultInferenceTools = (): InferenceToolDefinition[] => {
  const tools: InferenceToolDefinition[] = getBuiltInInferenceTools()

  try {
    const customTools = customToolRegistry
      .getDefinitions()
      .filter(def => def.enabled)
      .map(def => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }))
    tools.push(...customTools)
  } catch {
    // Ignore custom tool discovery failures in request-path fallback.
  }

  // MCP tools are available only through mcp_manager list_tools/invoke.

  return dedupeToolsByName(tools)
}

// Delegation tools are always excluded (no nested subagents or external reviewers).
const SUBAGENT_EXCLUDED_TOOL_NAMES = new Set(['subagent', 'subagent_manager', 'claude_bridge'])

// These orchestration tools are always exposed to a child, including when a
// parent supplies an explicit tool whitelist.
const REQUIRED_SUBAGENT_TOOL_NAMES = new Set(['multi_call', 'repl'])

// Default tool set when a subagent request omits `tools`. Mirrors the renderer's
// DEFAULT_SUBAGENT_TOOLS; every name here is in HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES.
const DEFAULT_SUBAGENT_TOOL_NAMES = [
  'read_file',
  'read_files',
  'glob',
  'ripgrep',
  'browse_web',
  'brave_search',
  'edit_file',
  'multi_edit',
  'multi_call',
  'create_file',
  'delete_file',
  'bash',
]

const resolveInferenceToolsByName = (
  names: string[] | undefined
): { tools: InferenceToolDefinition[]; resolvedNames: string[]; unknownNames: string[] } => {
  // Host-gated names drop out of the default set so they are not reported
  // as unknown on hosts that cannot run them.
  const requested = Array.isArray(names) ? names : DEFAULT_SUBAGENT_TOOL_NAMES.filter(isBuiltInToolAvailable)
  const wanted = new Set([
    ...requested.filter(name => typeof name === 'string' && !SUBAGENT_EXCLUDED_TOOL_NAMES.has(name)),
    ...REQUIRED_SUBAGENT_TOOL_NAMES,
  ])
  const available = resolveDefaultInferenceTools()
  const tools = available.filter(tool => wanted.has(tool.name))
  const resolvedNames = tools.map(tool => tool.name)
  const resolvedSet = new Set(resolvedNames)
  const unknownNames = [...wanted].filter(name => !resolvedSet.has(name))
  return { tools, resolvedNames, unknownNames }
}


const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

const createOrchestratorToolExecutor = (toolOrchestrator: OrchestratorLike): ToolExecutor => async (toolCall, context) => {
  const requestedTimeout = context.timeoutMs
  const timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1_000, Math.min(requestedTimeout, 600_000))
    : 300_000

  const parsedArguments =
    typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments)
          } catch {
            return {}
          }
        })()
      : toolCall.arguments ?? {}

  if ((toolCall.name === 'bash' || toolCall.name === 'powershell') && parsedArguments.timeoutMs === undefined && context.bashTimeoutMs !== undefined)
    parsedArguments.timeoutMs = Math.min(180000, Math.max(1000, context.bashTimeoutMs))
  const signal = context.signal
  if (signal?.aborted) {
    const abortError = new Error('Tool execution aborted')
    abortError.name = 'AbortError'
    throw abortError
  }

  const job = toolOrchestrator.submit(toolCall.name, parsedArguments, {
    timeoutMs,
    deadlineMs: Date.now() + timeoutMs,
    rootPath: context.rootPath ?? null,
    fullAccess: context.fullAccess === true,
    operationMode: context.operationMode ?? 'execute',
    conversationId: context.conversationId ?? null,
    messageId: context.messageId ?? null,
    streamId: context.streamId ?? null,
    toolCallId: toolCall.id ?? null,
  })

  const startedAt = Date.now()
  while (true) {
    // Cancel the in-flight job promptly when the run is aborted.
    if (signal?.aborted) {
      toolOrchestrator.cancel(job.id)
      const abortError = new Error('Tool execution aborted')
      abortError.name = 'AbortError'
      throw abortError
    }

    const current = toolOrchestrator.getJob(job.id)
    if (!current) {
      throw new Error(`Tool job disappeared: ${job.id}`)
    }

    if (current.status === 'completed') {
      return current.result
    }

    if (current.status === 'failed') {
      throw new Error(current.error || `Tool execution failed: ${toolCall.name}`)
    }

    if (current.status === 'cancelled') {
      throw new Error(`Tool execution cancelled: ${toolCall.name}`)
    }

    // Read a terminal result before enforcing the polling deadline. Otherwise
    // output completed between the final poll and this deadline is discarded.
    if (Date.now() - startedAt >= timeoutMs) break
    await sleep(100)
  }

  toolOrchestrator.cancel(job.id)
  throw new Error(`Tool execution timed out after ${timeoutMs}ms: ${toolCall.name}`)
}

export function registerHeadlessServerRoutes(app: Express, deps: HeadlessServerRouteDeps): void {
  // OAuth credential overrides are not a supported local API authentication mode.
  app.use(['/api/conversations', '/api/headless/subagent', '/api/headless/ephemeral', '/api/headless/provider/openai'], (req, res, next) => {
    const provider = normalizeProviderRoute(String(req.body?.provider || 'openaichatgpt'))
    if ((provider === 'openaichatgpt' || provider === 'openrouter') &&
        (req.body?.accessToken || req.body?.access_token || req.body?.refreshToken || req.body?.refresh_token || req.headers['chatgpt-account-id'])) {
      res.status(400).json({ error: 'OAuth credentials are server-owned. Connect the account in Settings instead of supplying tokens.' })
      return
    }
    next()
  })
  const tokenStore = new ProviderTokenStore(deps.db)
  initializeAuth(deps.db)

  const executeToolViaOrchestrator = createOrchestratorToolExecutor(deps.orchestrator ?? defaultToolOrchestrator)

  // Gateway flags are resolved once at startup. Chat and route-independent runs default on.
  const gatewayFlags = resolveGatewayFlags()
  // One process-wide app-session owner for every Railway-backed path, including
  // OpenRouter streaming (which previously bypassed this shared refresh policy).
  const appAuth = createAppAuthTokenManager()
  const railway = createRailwayClient({ auth: appAuth })
  const providerRouter = new ProviderRouter({ tokenStore, appAuth })

  // One shared pause/resume registry across the chat orchestrator (which pauses the
  // loop) and the POST /api/resume route (which resolves the paused decision).
  applyHostProviderEnvironment()
  reconcileHeadlessRuns(deps.db, hostEpoch)
  const decisionBroker = new DecisionBroker(new DecisionReceiptRepo(deps.db))

  // Detach/reattach registry (gateway.resumableRuns, default ON). A chat run's lifetime
  // is owned by its RunSession rather than the SSE socket, so route changes and renderer
  // reloads detach instead of aborting. Explicit false retains the legacy
  // disconnect==abort path and leaves the reaper stopped.
  const operationReceipts = new OperationReceiptRepo(deps.db)
  configureSnapshotScratch(join(getServerTempDir(), 'snapshots'))
  const runSessions = new RunSessionRegistry()
  activeRegistries.add(runSessions)
  const readSnapshotMessage = deps.db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?')
  runSessions.setMainSessionFactory(session => {
    const projector = new RunSnapshotProjector(session.snapshotPayloads)
    session.setProjector(event => projector.apply(event))
    session.setEventObserver(event => {
      if (event.type === 'message_queue_updated') {
        for (const item of event.snapshot.items) {
          if (item.status === 'delivered' || item.status === 'failed' || item.status === 'cancelled')
            operationReceipts.settleQueue(item.requestId, item.status === 'delivered' ? 'completed' : item.status)
        }
      }
      if (event.type === 'complete' || (event.type === 'error' && event.terminal !== false)) {
        operationReceipts.finishStream(session.streamId, session.signal.aborted ? 'cancelled'
          : event.type === 'complete' && !event.providerError ? 'completed' : 'failed')
      }
    })
    session.setSnapshotProvider(() => {
      // better-sqlite3 reads and capture are synchronous: no mutation can interleave
      // between these exact rows, the decision map and sequence S.
      const referencedIds = projector.referencedMessageIds()
      const rows = referencedIds.map(id => readSnapshotMessage.get(id, session.conversationId)).filter(Boolean) as any[]
      const present = new Set(rows.map(row => row.id))
      const snapshot = projector.snapshot({ epoch: hostEpoch, streamId: session.streamId,
        conversationId: session.conversationId!, stateSeq: session.latestSeq, effectiveConfiguration: session.effectiveConfiguration,
        persisted: rows.map(row => ({ id: row.id, revision: row.revision, row })),
        deletedMessageIds: referencedIds.filter(id => !present.has(id)),
        pendingDecisions: decisionBroker.snapshot(session.streamId).pending })
      return snapshot
    })
  })
  if (gatewayFlags.resumableRuns) reaperStops.add(runSessions.startReaper())

  registerCrudRoutes(app, deps)
  registerProviderAuthRoutes(app, { tokenStore })
  registerMobileUiRoutes(app)
  registerHostRuntimeRoutes(app, () => {
    deps.db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)')
      .run('a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3', 'community-user')
  })
  registerCustomToolsRoutes(app)
  registerCustomToolRpcRoutes(app)
  registerHostAppBridgeRoutes(app)
  registerCapabilityRoutes(app, { getDefaultTools: resolveDefaultInferenceTools })
  registerEphemeralGenerateRoutes(app, { tokenStore })
  registerLineageRoutes(app, deps)

  // Phase 5 cloud gateway: storage-aware /api/gw/* CRUD + merge and /api/cloud/*
  // authenticated pass-through. Mounted UNCONDITIONALLY — the renderer is now a thin
  // client that routes all CRUD/reads/cloud through these paths (Phase 5 cutover), so
  // they must always be available. They are additive routes (nothing else served
  // /api/gw or /api/cloud), so mounting them changes no existing behavior. Both share
  // one single-flight app-token manager (sole Supabase refresher) + one Railway client.
  {
    registerGatewayRoutes(app, {
      railway,
      mirror: createCloudMirrorService({ db: deps.db, statements: deps.statements }),
      auth: appAuth,
      db: deps.db,
      statements: deps.statements,
      enabled: true,
    })
    registerCloudProxyRoutes(app, { railway, enabled: true })
  }


  const bridgeWaitExecutor: ToolExecutor = async (call, context) => {
    if (call.name !== 'claude_bridge') return executeToolViaOrchestrator(call, context)
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    if (args?.action !== 'wait') return executeToolViaOrchestrator(call, context)
    return withToolAccess(context.fullAccess, () => claudeBridge.execute(args, {
      ...context, rootPath: context.rootPath ?? undefined,
      registerWait: (jobId, completion) => watchService.registerBridgeJob(jobId, completion, context,
        deps.statements.getConversationById?.get(context.conversationId)?.project_id ?? null, call.id),
    }))
  }
  const watcherExecutor = createWatchExecutor(bridgeWaitExecutor, watchService,
    id => deps.statements.getConversationById?.get(id)?.project_id ?? null)
  const multiCallToolExecutor = createMultiCallDispatchExecutor(createReplDispatchExecutor(createContextStatusExecutor(watcherExecutor)))
  const subagentRunService = new SubagentRunService({
    statements: deps.statements,
    tokenStore,
    providerRouter,
    // Child tools use the leaf executor. They can never re-enter the parent
    // subagent dispatcher, preserving the no-nested-subagents invariant.
    toolExecutor: multiCallToolExecutor,
    resolveToolsByName: resolveInferenceToolsByName,

    // Share the chat RunSessionRegistry so background subagent runs publish their
    // stream events to a session the existing GET /api/streams/:streamId route can
    // replay — this is what lets the transcript viewer watch a run live. Gated on
    // resumableRuns (same gate as that route); off => runs just don't stream live.
    runSessions: gatewayFlags.resumableRuns ? runSessions : undefined,
  })
  // Startup reconciler: any subagent run left 'running' by a previous process
  // crash is an orphan (this fresh process owns no live loop), so flip it to a
  // resumable terminal state now, before anything can read stale 'running' rows.
  try {
    const reconciled = subagentRunService.reconcileOrphanedRuns()
    if (reconciled > 0) console.log(`[subagent] reconciled ${reconciled} orphaned running run(s) -> resumable`)
  } catch (error) {
    console.warn('[subagent] orphaned-run reconciliation failed (continuing):', error)
  }

  // Compose two interceptors ahead of the orchestrator registry:
  //   subagent_manager (global async manager, branch-scoped) -> subagent (legacy
  //   blocking dispatch) -> multiCall/leaf. Both interceptors see the full
  //   ToolExecutionContext (incl. lineageId) that the registry path would drop.
  const subagentDispatchExecutor = createSubagentDispatchExecutor({
    leafExecutor: multiCallToolExecutor,
    subagentRunner: subagentRunService,
  })
  const chatToolExecutor = createSubagentManagerExecutor({
    leafExecutor: subagentDispatchExecutor,
    runner: subagentRunService,
    registerWait: (runId, attempt, completion, context, toolCallId) => watchService.registerSubagentRun(
      runId, attempt, completion, context,
      deps.statements.getConversationById?.get(context.conversationId)?.project_id ?? null, toolCallId),
  })

  registerSubagentRoutes(app, {
    runService: subagentRunService,
    validateTarget: (conversationId: string, parentMessageId: string) => {
      const conversation = deps.statements.getConversationById?.get(conversationId)
      if (!conversation) return { status: 404, error: 'Conversation not found' }
      const parentMessage = deps.statements.getMessageById?.get(parentMessageId)
      if (!parentMessage) return { status: 404, error: 'Parent message not found' }
      return null
    },
  })

  registerTestHarnessRoutes(app, {
    getDefaultTools: resolveDefaultInferenceTools,
  })
  const chatOrchestrator = new ChatOrchestrator({
    ...deps,
    tokenStore,
    providerRouter,
    toolExecutor: chatToolExecutor,
    defaultToolsProvider: resolveDefaultInferenceTools,
    decisionBroker,
    // Phase 3: in-process chat hooks (fires only when a request sets hooksEnabled).
    hookRunner: runHookRequest,
    // Phase 4: cloud (openrouter) free-tier relay + Railway id adoption. Default OFF.
    cloudChatEnabled: gatewayFlags.chat,
  })
  if (gatewayFlags.resumableRuns) {
    watchService.configureContinuation({
      retain: context => chatOrchestrator.retainWatch(context),
      deliver: (event, originStreamId, content) => {
        const result = chatOrchestrator.submitWatchMessage(event.conversationId, event.lineageId, originStreamId, {
          requestId: `watcher:${event.handle}`,
          watcherCompletion: { handle: event.handle, originMessageId: event.messageId,
            ...(event.source ? { source: event.source } : {}),
            ...(event.registrationToolCallId ? { registrationToolCallId: event.registrationToolCallId } : {}) },
          content: content ?? `Watcher completion: ${event.kind} watch ${event.handle} ${event.state}. This is an automated event from the watcher registered in this branch. Continue the original task using available results; inspect them with normal tools as needed.`,
        })
        if (result.restart) {
          launchQueuedSuccessor(chatOrchestrator, runSessions, result.restart)
          return { ...event, delivery: 'restarted', streamId: result.restart.streamId!, parentId: result.restart.parentId }
        }
        if (result.restartStreamId) return { ...event, delivery: 'restarted', streamId: result.restartStreamId }
        return { ...event, delivery: 'queued', streamId: result.snapshot?.streamId }
      },
    })
  }
  registerChatRoutes(app, {
    admissions: new RunAdmissionService({ epoch: hostEpoch, receipts: operationReceipts,
      orchestrator: chatOrchestrator, sessions: runSessions, executionDefaults: () => readHostExecutionPreferences().values }),
    orchestrator: chatOrchestrator,
    decisionBroker,
    runSessions,
    resumableRuns: gatewayFlags.resumableRuns,
  })
}

const activeRegistries = new Set<RunSessionRegistry>()
const reaperStops = new Set<() => void>()
export function stopHeadlessSessions(): void {
  for (const stop of reaperStops) stop()
  reaperStops.clear()
  for (const registry of activeRegistries) registry.disposeAll()
  activeRegistries.clear()
  disposeSnapshotScratch()
}
