// server/localServer.ts
// Embedded local SQLite server for dual-sync in Electron mode
// This server prefers port 3002 and falls back to available local ports.

import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import cors from 'cors'
import crypto from 'crypto'
import express from 'express'
import fs from 'fs'
import { createRequire as createNodeRequire } from 'module'
import type { AddressInfo } from 'net'
import path from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { isManagedToolPath } from './utils/managedToolPaths.js'

// Runtime-neutral server graph (Phase 1 server/client separation)
import { registerBuiltInTools, type BuiltInToolHandler } from './builtinToolRegistry.js'
import { buildCorsOriginOption } from './corsPolicy.js'
import type { ToolSandboxHost } from './hostCapabilities.js'
import {
  getHostCapabilities,
  getServerDataDir,
  getServerTempDir,
  setHostGatedToolNames,
  tryGetHostCapabilities,
  tryGetServerConfig,
} from './serverHost.js'
import { resolveToolWorkspaceCwd, validateAndResolvePath } from './toolPathPolicy.js'
import { shouldUseUtilityRuntimeForTool } from './toolSandboxPolicy.js'

// Tool imports
// Individual built-in tool handler imports moved to
// server/server/builtinToolRegistry.ts with the registrations.
import { registerHeadlessServerRoutes } from './headlessServer/index.js'
import { attachChatErrorCode } from './headlessServer/providers/providerErrorFormatter.js'
import {
  handleLspWebSocketUpgrade,
  initializeLspLocalServer,
  registerLspRoutes,
  shutdownLspLocalServer,
} from './lsp/localServerIntegration.js'
import { registerLocalOperationsRoutes } from './localOperations.js'
import { localAnalyticsWorkerClient } from './localAnalyticsWorkerClient.js'
import { createToolsStatements, initializeToolsSchema, pruneOldTools, registerToolsRoutes } from './localToolsRoutes.js'
import { mcpManager } from './mcp/mcpManager.js'
import { toMcpExecutionResult } from './mcp/mcpToolResult.js'
import { registerMcpRoutes } from './mcp/mcpRoutes.js'
import { registerProxyRoutes } from './proxyGateway.js'
import { registerOpenAiOAuthRoutes, startOpenAiOAuthCallbackServer, stopOpenAiOAuth } from './routes/openaiOAuthRoutes.js'
import { registerRunStateRoutes } from './routes/runStateRoutes.js'
import { registerSyncStorageRoutes } from './routes/syncStorageRoutes.js'
import { registerMemoryRoutes } from './routes/memoryRoutes.js'
import { registerHookRoutes } from './routes/hookRoutes.js'
import { registerUndoRoutes } from './routes/undoRoutes.js'
import { registerToolExecutionRoutes } from './routes/toolExecutionRoutes.js'
import { registerAppStoreRoutes } from './routes/appStoreRoutes.js'
import { registerJobRoutes } from './routes/jobRoutes.js'
import { registerAnalyticsRoutes } from './routes/analyticsRoutes.js'
import { registerUserProjectRoutes } from './routes/userProjectRoutes.js'
import { registerNoteSearchRoutes } from './routes/noteSearchRoutes.js'
import { registerConversationRoutes } from './routes/conversationRoutes.js'
import { skillRegistry } from './skills/skillLoader.js'
import { registerSkillRoutes } from './skills/skillRoutes.js'
import { customToolRegistry, type CustomToolsChangedEvent, ToolResult } from './tools/customToolLoader.js'
import { JobFilter, JobOptions, toolOrchestrator } from './tools/orchestrator/index.js'

// validateAndResolvePath and resolveToolWorkspaceCwd moved to
// server/server/toolPathPolicy.ts (imported above) so the server-owned tool
// registry can share them.


// BuiltInToolHandler type moved to electron/server/builtinToolRegistry.ts.

// Registry for built-in tools (initialized in setupServer)
const builtInTools: Map<string, BuiltInToolHandler> = new Map()

let searchNotesForToolRegistry:
  | ((params: { userId: string; query: string; projectId?: string; limit: number }) => Array<Record<string, any>>)
  | null = null
let searchTopLevelUserMessagesForToolRegistry:
  | ((params: { userId: string; query: string; projectId?: string; limit: number }) => Array<Record<string, any>>)
  | null = null

// The out-of-process tool sandbox is a host capability now: Electron supplies
// a UtilityToolRuntimeHost (utilityProcess.fork), standalone supplies a
// NodeToolRuntimeHost (child_process.fork). Assigned during startLocalServer.
let toolSandbox: ToolSandboxHost | null = null
let utilityRuntimeAvailable = false

function getToolRuntimeMode(): 'local' | 'utility' {
  const configured = tryGetServerConfig()?.toolRuntime.mode
  if (configured) return configured
  // Legacy env fallback for code paths that run before host configuration.
  return process.env.YGG_TOOLS_RUNTIME?.trim().toLowerCase() === 'utility' ? 'utility' : 'local'
}

function isUtilityRuntimeFallbackDisabled(): boolean {
  const config = tryGetServerConfig()
  if (config) return !config.toolRuntime.allowInProcessFallback
  const rawValue = process.env.DISABLE_TOOL_RUNTIME_FALLBACK?.trim().toLowerCase()
  if (!rawValue) return false
  return rawValue === '1' || rawValue === 'true' || rawValue === 'yes' || rawValue === 'on'
}

// UTILITY_RUNTIME_TOOL_WHITELIST and shouldUseUtilityRuntimeForTool moved to
// server/server/toolSandboxPolicy.ts (imported above).

function shouldUseUtilityRuntimeForCustomTool(toolName: string): boolean {
  if (getToolRuntimeMode() !== 'utility') return false
  if (!utilityRuntimeAvailable) return false
  if (!customToolRegistry.hasCustomTool(toolName)) return false
  return true
}

// Initialize built-in tools registry. The handlers live in the server-owned
// registry module (electron/server/builtinToolRegistry.ts). The 26th built-in,
// memory_manage, is registered inside setupServer() next to the memory routes.
function initializeBuiltInToolRegistry() {
  const capabilities = getHostCapabilities()
  registerBuiltInTools(builtInTools, {
    getStatements: () => statements,
    getSearchNotes: () => searchNotesForToolRegistry,
    getSearchTopLevelUserMessages: () => searchTopLevelUserMessagesForToolRegistry,
    browserEngine: capabilities.browserEngine,
  })
  const gated = new Set<string>()
  if (!capabilities.browserEngine) gated.add('browse_web')
  setHostGatedToolNames(gated)
  console.log(`[LocalServer] Initialized ${builtInTools.size} built-in tools`)
}

function registerCustomToolsWithOrchestrator(): number {
  const definitions = customToolRegistry.getDefinitions()
  for (const customToolDef of definitions) {
    toolOrchestrator.registerTool(customToolDef.name, async (args, options) => {
      const sandbox = toolSandbox
      if (sandbox && shouldUseUtilityRuntimeForCustomTool(customToolDef.name)) {
        try {
          return await sandbox.executeTool(customToolDef.name, args, {
            rootPath: options?.rootPath,
            operationMode: options?.operationMode,
            conversationId: options?.conversationId,
            messageId: options?.messageId,
            streamId: options?.streamId,
          })
        } catch (utilityError) {
          if (isUtilityRuntimeFallbackDisabled()) {
            throw utilityError
          }
          console.warn(
            `[LocalServer] Utility runtime failed for orchestrator custom tool ${customToolDef.name}; falling back to local execution:`,
            utilityError
          )
        }
      }

      return customToolRegistry.executeTool(customToolDef.name, args, {
        cwd: options?.rootPath,
        rootPath: options?.rootPath,
        operationMode: options?.operationMode,
        conversationId: options?.conversationId,
        messageId: options?.messageId,
        streamId: options?.streamId,
      })
    })
  }
  console.log(`[LocalServer] Registered ${definitions.length} custom tools with orchestrator`)
  return definitions.length
}

let customToolsListenerBound = false
function bindCustomToolsLifecycleListener(): void {
  if (customToolsListenerBound) return
  customToolsListenerBound = true

  customToolRegistry.on('toolsChanged', (event: CustomToolsChangedEvent) => {
    registerCustomToolsWithOrchestrator()
    console.log(`[LocalServer] Custom tools changed (${event.reason}); total=${event.totalCount}`)

    const sandbox = toolSandbox
    if (!utilityRuntimeAvailable || !sandbox) {
      return
    }

    void sandbox
      .reloadCustomTools(`local:${event.reason}`)
      .then(result => {
        console.log(
          `[LocalServer] Synced custom tools to utility runtime (${event.reason}); total=${
            result.totalCount ?? event.totalCount
          }; durationMs=${result.durationMs ?? 'n/a'}`
        )
      })
      .catch(error => {
        console.warn(
          `[LocalServer] Failed syncing custom tools to utility runtime (${event.reason}); utility runtime may be temporarily stale:`,
          error
        )
      })
  })
}

// Recreated on every startLocalServer call so a stop/start cycle cannot
// double-register routes on a stale Express app.
let app = express()
let server: any = null
let wss: WebSocketServer | null = null
let db: Database.Database | null = null
let statements: any = {}
let currentDbPath: string | null = null

let sqliteVecAvailable = false
let sqliteVecLoadError: string | null = null

const requireCjs = createNodeRequire(import.meta.url)

const sqliteVecLoadCandidates: Array<{ label: string; loader: () => string }> = [
  {
    label: '@sqlite/vec',
    loader: () => {
      const sqliteVecModule = requireCjs('@sqlite/vec') as any
      if (typeof sqliteVecModule?.getLoadablePath === 'function') {
        const loaded = sqliteVecModule.getLoadablePath()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default?.getLoadablePath === 'function') {
        const loaded = sqliteVecModule.default.getLoadablePath()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.path === 'string') return sqliteVecModule.path
      if (typeof sqliteVecModule?.default?.path === 'string') return sqliteVecModule.default.path
      if (typeof sqliteVecModule?.load === 'function') {
        const loaded = sqliteVecModule.load()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default === 'function') {
        const loaded = sqliteVecModule.default()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default?.load === 'function') {
        const loaded = sqliteVecModule.default.load()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule === 'string') return sqliteVecModule
      throw new Error('Module loaded but no extension path export found')
    },
  },
  {
    label: 'sqlite-vec',
    loader: () => {
      const sqliteVecModule = requireCjs('sqlite-vec') as any
      if (typeof sqliteVecModule?.getLoadablePath === 'function') {
        const loaded = sqliteVecModule.getLoadablePath()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default?.getLoadablePath === 'function') {
        const loaded = sqliteVecModule.default.getLoadablePath()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.path === 'string') return sqliteVecModule.path
      if (typeof sqliteVecModule?.default?.path === 'string') return sqliteVecModule.default.path
      if (typeof sqliteVecModule?.load === 'function') {
        const loaded = sqliteVecModule.load()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default === 'function') {
        const loaded = sqliteVecModule.default()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule?.default?.load === 'function') {
        const loaded = sqliteVecModule.default.load()
        if (typeof loaded === 'string') return loaded
      }
      if (typeof sqliteVecModule === 'string') return sqliteVecModule
      throw new Error('Module loaded but no extension path export found')
    },
  },
]

function resolveSqliteExtensionLoadPath(extensionPath: string): string {
  if (typeof extensionPath !== 'string' || extensionPath.trim().length === 0) {
    return extensionPath
  }

  const trimmed = extensionPath.trim()
  const unpackedCandidate = trimmed.replace(/\.asar([\\/])/i, '.asar.unpacked$1')
  if (unpackedCandidate !== trimmed && fs.existsSync(unpackedCandidate)) {
    return unpackedCandidate
  }

  return trimmed
}

function tryEnableSqliteVec(database: Database.Database): { available: boolean; loadedFrom?: string; error?: string } {
  const failureReasons: string[] = []

  for (const candidate of sqliteVecLoadCandidates) {
    try {
      const rawExtensionPath = candidate.loader()
      const extensionPath = resolveSqliteExtensionLoadPath(rawExtensionPath)
      database.loadExtension(extensionPath)
      return { available: true, loadedFrom: candidate.label }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failureReasons.push(`${candidate.label}: ${reason}`)
      console.debug(`[LocalServer] sqlite-vec candidate ${candidate.label} not available: ${reason}`)
    }
  }

  return {
    available: false,
    error:
      failureReasons.length > 0
        ? `sqlite-vec failed to load (${failureReasons.join(' | ')})`
        : 'sqlite-vec extension package not installed or failed to load',
  }
}

/**
 * A single, run-ONCE schema migration. `up` must be IDEMPOTENT (guard ALTERs with a
 * PRAGMA table_info check, use CREATE ... IF NOT EXISTS) so a crash between applying
 * the DDL and stamping user_version is harmless — the next launch re-runs it as a
 * no-op and then stamps. Never edit or reorder a shipped migration; only APPEND a
 * new one with the next integer version.
 */
interface SchemaMigration {
  version: number
  name: string
  up: (database: Database.Database) => void
}

const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: 'subagent_manager_columns',
    up: database => {
      // subagent_runs gained handle / attempt / last_turn_at (+ the handle & tool_call
      // indexes) for the subagent-manager work. Databases created before it lack the
      // columns; add them, then the indexes. Guarded so it is also a safe no-op on a
      // fresh DB whose CREATE TABLE already declared the columns.
      const columns = database.prepare('PRAGMA table_info(subagent_runs)').all() as { name: string }[]
      const hasColumn = (name: string) => columns.some(column => column.name === name)
      if (!hasColumn('handle')) database.exec('ALTER TABLE subagent_runs ADD COLUMN handle TEXT')
      if (!hasColumn('attempt')) database.exec('ALTER TABLE subagent_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0')
      if (!hasColumn('last_turn_at')) database.exec('ALTER TABLE subagent_runs ADD COLUMN last_turn_at DATETIME')
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_tool_call ON subagent_runs(tool_call_id, created_at) WHERE tool_call_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_runs_handle ON subagent_runs(handle) WHERE handle IS NOT NULL;
      `)
    },
  },
]

/**
 * Apply pending schema migrations exactly once each, tracked by SQLite's per-database
 * PRAGMA user_version. Migrations are applied in ascending version order; user_version
 * is stamped only AFTER a migration's `up` succeeds (each `up` is idempotent, so a
 * partial/crashed apply is retried harmlessly next launch). A fresh database — whose
 * CREATE TABLE blocks already match the latest schema — still passes through these as
 * no-ops and gets stamped to the latest version, so fresh and migrated installs
 * converge. Throws if a migration fails (surfacing a real schema problem loudly).
 */
function runSchemaMigrations(database: Database.Database): void {
  const currentVersion = Number(database.pragma('user_version', { simple: true })) || 0
  const targetVersion = SCHEMA_MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (currentVersion >= targetVersion) return

  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    try {
      migration.up(database)
      // Stamp only after the (idempotent) DDL succeeds — never before.
      database.pragma(`user_version = ${migration.version}`)
      console.log(`[LocalServer] Applied schema migration v${migration.version} (${migration.name})`)
    } catch (error) {
      console.error(`[LocalServer] Schema migration v${migration.version} (${migration.name}) failed:`, error)
      throw error
    }
  }
}

// Initialize database at specified path
function initializeLocalDatabase(dbPath: string) {
  currentDbPath = dbPath

  // Ensure directory exists
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // DEV MODE: Delete old database if it exists to force schema recreation
  // Remove this in production and add proper migrations
  // if (fs.existsSync(dbPath)) {
  //   console.log('[LocalServer] DEV MODE: Deleting old database to recreate with new schema')
  //   fs.unlinkSync(dbPath)
  // }

  db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  const sqliteVecStatus = tryEnableSqliteVec(db)
  sqliteVecAvailable = sqliteVecStatus.available
  sqliteVecLoadError = sqliteVecStatus.available ? null : sqliteVecStatus.error || 'unknown error'
  if (sqliteVecAvailable) {
    console.log(`[LocalServer] sqlite-vec enabled (${sqliteVecStatus.loadedFrom || 'unknown loader'})`)
  } else {
    console.warn(`[LocalServer] sqlite-vec unavailable: ${sqliteVecLoadError}`)
  }

  // Create tables (minimal schema for sync operations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT,
      context TEXT,
      system_prompt TEXT,
      cwd TEXT,
      storage_mode TEXT NOT NULL CHECK (storage_mode IN ('cloud','local')) DEFAULT 'cloud',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      title TEXT,
      model_name TEXT DEFAULT 'unknown',
      system_prompt TEXT,
      conversation_context TEXT,
      research_note TEXT,
      cwd TEXT,
      storage_mode TEXT NOT NULL CHECK (storage_mode IN ('cloud','local')) DEFAULT 'cloud',
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  // Ensure project cwd column exists for older DBs
  try {
    const columns = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
    const columnNames = new Set(columns.map(col => col.name))
    if (!columnNames.has('cwd')) {
      db.exec(`ALTER TABLE projects ADD COLUMN cwd TEXT`)
    }
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate projects table:', error)
  }

  // Ensure favorite column exists for older DBs
  try {
    const columns = db.prepare(`PRAGMA table_info(conversations)`).all() as { name: string }[]
    const columnNames = new Set(columns.map(col => col.name))
    if (!columnNames.has('favorite')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`)
    }
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate conversations table:', error)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_user_favorite ON conversations(user_id, favorite);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_title ON conversations(user_id, title);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS lineages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_lineage_id TEXT,
      forked_from_message_id TEXT,
      root_message_id TEXT,
      head_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','archived')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_lineage_id) REFERENCES lineages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fork_operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      source_lineage_id TEXT,
      target_lineage_id TEXT NOT NULL,
      source_message_id TEXT,
      materialized_message_id TEXT,
      operation TEXT NOT NULL DEFAULT 'fork',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','materialized','error')),
      metadata_json TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (source_lineage_id) REFERENCES lineages(id) ON DELETE SET NULL,
      FOREIGN KEY (target_lineage_id) REFERENCES lineages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lineages_conversation_updated ON lineages(conversation_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lineages_parent ON lineages(parent_lineage_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_lineages_head_message ON lineages(head_message_id) WHERE head_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fork_operations_conversation_created ON fork_operations(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fork_operations_target_status ON fork_operations(target_lineage_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_fork_operations_source_message ON fork_operations(source_message_id) WHERE source_message_id IS NOT NULL;
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      lineage_id TEXT,
      children_ids TEXT DEFAULT '[]',
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'ex_agent', 'tool')),
      content TEXT NOT NULL,
      plain_text_content TEXT,
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      model_name TEXT DEFAULT 'unknown',
      note TEXT,
      note_color TEXT,
      ex_agent_session_id TEXT,
      ex_agent_type TEXT,
      content_blocks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)

  // Ensure note_color column exists for older DBs
  try {
    const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
    const messageColumnNames = new Set(messageColumns.map(col => col.name))
    if (!messageColumnNames.has('note_color')) {
      db.exec(`ALTER TABLE messages ADD COLUMN note_color TEXT`)
    }
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate messages table:', error)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_runs (
      stream_id TEXT PRIMARY KEY,
      conversation_id TEXT,
      lineage_id TEXT,
      parent_message_id TEXT,
      user_message_id TEXT,
      assistant_message_id TEXT,
      final_message_id TEXT,
      stream_type TEXT NOT NULL DEFAULT 'primary' CHECK (stream_type IN ('primary','branch','tool','subagent')),
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','aborted','error')),
      end_reason TEXT CHECK (end_reason IN ('completed','aborted','error','pruned','unknown') OR end_reason IS NULL),
      provider TEXT,
      model_name TEXT,
      operation TEXT,
      source TEXT NOT NULL DEFAULT 'renderer' CHECK (source IN ('renderer','headless','subagent','tool','unknown')),
      root_message_id TEXT,
      origin_message_id TEXT,
      parent_stream_id TEXT,
      tool_call_id TEXT,
      error TEXT,
      metadata_json TEXT,
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_streaming_runs_conversation_started ON streaming_runs(conversation_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_runs_status_started ON streaming_runs(status, started_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_runs_parent_stream ON streaming_runs(parent_stream_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_streaming_runs_final_message ON streaming_runs(final_message_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      lineage_id TEXT NOT NULL,
      run_id TEXT,
      parent_tool_invocation_id TEXT,
      tool_call_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','aborted')),
      started_at DATETIME NOT NULL,
      ended_at DATETIME,
      duration_ms INTEGER,
      error TEXT,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (lineage_id) REFERENCES lineages(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_tool_invocation_id) REFERENCES tool_invocations(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_lineage_started ON tool_invocations(lineage_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_run_started ON tool_invocations(run_id, started_at) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_parent ON tool_invocations(parent_tool_invocation_id, started_at) WHERE parent_tool_invocation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tool_invocations_status ON tool_invocations(status, started_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      lineage_id TEXT,
      parent_message_id TEXT NOT NULL,
      tool_call_id TEXT,
      prompt TEXT NOT NULL,
      provider TEXT,
      model_name TEXT,
      system_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      final_response TEXT,
      error TEXT,
      turns_used INTEGER DEFAULT 0,
      tool_calls_used INTEGER DEFAULT 0,
      handle TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_turn_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subagent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
      content TEXT NOT NULL DEFAULT '',
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      content_blocks TEXT,
      sequence INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_message_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_conversation ON subagent_runs(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_subagent_messages_run_seq ON subagent_messages(run_id, sequence);
  `)
  // NOTE: the tool_call and handle indexes are created in the idempotent migration
  // block below (after the handle column is guaranteed to exist). They MUST NOT be
  // created here: on a pre-existing subagent_runs table the CREATE TABLE above is a
  // no-op, so this unconditional block would reference the not-yet-added `handle`
  // column and crash initializeLocalDatabase with "no such column: handle".

  // Idempotent migration for databases created by the previous inline schema.
  try {
    for (const tableName of ['messages', 'streaming_runs', 'subagent_runs']) {
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
      if (!columns.some(column => column.name === 'lineage_id')) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN lineage_id TEXT`)
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_lineage_created ON messages(lineage_id, created_at) WHERE lineage_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_streaming_runs_lineage_started ON streaming_runs(lineage_id, started_at) WHERE lineage_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_streaming_runs_lineage_status ON streaming_runs(lineage_id, status);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_lineage_created ON subagent_runs(lineage_id, created_at) WHERE lineage_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_lineage_status ON subagent_runs(lineage_id, status);
    `)
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate content lineage columns:', error)
  }

  // Versioned, run-ONCE schema migrations (tracked by PRAGMA user_version). Runs
  // AFTER the CREATE TABLE ... blocks above so every table exists, and BEFORE the
  // prepared statements below (which reference the migrated columns). See
  // runSchemaMigrations / SCHEMA_MIGRATIONS for the ordered list.
  runSchemaMigrations(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('image')),
      mime_type TEXT NOT NULL,
      storage TEXT NOT NULL CHECK (storage IN ('file','url')) DEFAULT 'file',
      url TEXT,
      file_path TEXT,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER,
      sha256 TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)

  try {
    const attachmentColumns = db.prepare(`PRAGMA table_info(message_attachments)`).all() as { name: string }[]
    const attachmentColumnNames = new Set(attachmentColumns.map(col => col.name))
    if (!attachmentColumnNames.has('short_id')) {
      db.exec(`ALTER TABLE message_attachments ADD COLUMN short_id TEXT`)
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_attachments_short_id ON message_attachments(short_id) WHERE short_id IS NOT NULL`)
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate message_attachments table:', error)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachment_links (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (attachment_id) REFERENCES message_attachments(id) ON DELETE CASCADE,
      UNIQUE(message_id, attachment_id)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_cost (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      approx_cost REAL DEFAULT 0.0,
      api_credit_cost REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `)

  initializeToolsSchema(db)

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_storage_project_updated ON conversations(user_id, storage_mode, project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_top_user_by_conv_created
      ON messages(conversation_id, created_at)
      WHERE parent_id IS NULL AND role = 'user';
  `)

  // Full-text index for top-level user message search (best effort)
  let topLevelMessageFtsAvailable = false
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS top_level_user_message_search USING fts5(
        message_id UNINDEXED,
        content,
        plain_text_content,
        note,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_insert
      AFTER INSERT ON messages
      WHEN NEW.parent_id IS NULL AND NEW.role = 'user'
      BEGIN
        INSERT INTO top_level_user_message_search (message_id, content, plain_text_content, note)
        VALUES (
          NEW.id,
          COALESCE(NEW.content, ''),
          COALESCE(NEW.plain_text_content, ''),
          COALESCE(NEW.note, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_update
      AFTER UPDATE ON messages
      BEGIN
        DELETE FROM top_level_user_message_search WHERE message_id = OLD.id;
        INSERT INTO top_level_user_message_search (message_id, content, plain_text_content, note)
        SELECT
          NEW.id,
          COALESCE(NEW.content, ''),
          COALESCE(NEW.plain_text_content, ''),
          COALESCE(NEW.note, '')
        WHERE NEW.parent_id IS NULL AND NEW.role = 'user';
      END;

      CREATE TRIGGER IF NOT EXISTS top_level_user_message_search_delete
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM top_level_user_message_search WHERE message_id = OLD.id;
      END;
    `)

    db.exec(`DELETE FROM top_level_user_message_search;`)
    db.exec(`
      INSERT INTO top_level_user_message_search (message_id, content, plain_text_content, note)
      SELECT
        id,
        COALESCE(content, ''),
        COALESCE(plain_text_content, ''),
        COALESCE(note, '')
      FROM messages
      WHERE parent_id IS NULL AND role = 'user';
    `)

    topLevelMessageFtsAvailable = true
  } catch (ftsError) {
    console.warn(
      '[LocalServer] FTS5 unavailable for top-level message search. Falling back to fuzzy-only search.',
      ftsError
    )
  }

  if (topLevelMessageFtsAvailable) {
    console.log('[LocalServer] Top-level message FTS index ready')
  }

  // Note search docs + FTS index for per-message notes (best effort)
  let noteSearchFtsAvailable = false
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_search_docs (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        project_id TEXT,
        user_id TEXT NOT NULL,
        storage_mode TEXT NOT NULL CHECK (storage_mode IN ('cloud','local')) DEFAULT 'local',
        conversation_title TEXT,
        note TEXT NOT NULL,
        message_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        note_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_note_search_docs_user_note_updated
        ON note_search_docs(user_id, note_updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_note_search_docs_user_project_note_updated
        ON note_search_docs(user_id, project_id, note_updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_note_search_docs_conversation_id
        ON note_search_docs(conversation_id);

      CREATE TABLE IF NOT EXISTS note_search_embedding_state (
        message_id TEXT PRIMARY KEY,
        content_hash TEXT,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        embedding_updated_at DATETIME,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (embedding_status IN ('pending','ready','error','stale')),
        last_error TEXT,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS note_search_vector_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        vector_table_name TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO note_search_vector_config (id, vector_table_name) VALUES (1, 'note_search_vec');
    `)

    try {
      const vectorConfigColumns = db.prepare(`PRAGMA table_info(note_search_vector_config)`).all() as { name: string }[]
      const vectorConfigColumnNames = new Set(vectorConfigColumns.map(col => col.name))
      if (!vectorConfigColumnNames.has('embedding_model')) {
        db.exec(`ALTER TABLE note_search_vector_config ADD COLUMN embedding_model TEXT`)
      }
      if (!vectorConfigColumnNames.has('embedding_dimensions')) {
        db.exec(`ALTER TABLE note_search_vector_config ADD COLUMN embedding_dimensions INTEGER`)
      }
      if (!vectorConfigColumnNames.has('vector_table_name')) {
        db.exec(`ALTER TABLE note_search_vector_config ADD COLUMN vector_table_name TEXT`)
      }
      if (!vectorConfigColumnNames.has('updated_at')) {
        db.exec(`ALTER TABLE note_search_vector_config ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`)
      }
    } catch (vectorConfigMigrationError) {
      console.warn('[LocalServer] Failed to migrate note_search_vector_config table:', vectorConfigMigrationError)
    }

    if (sqliteVecAvailable) {
      const configuredDimensionsRow = db.prepare(
        `SELECT embedding_dimensions, vector_table_name FROM note_search_vector_config WHERE id = 1`
      ).get() as { embedding_dimensions?: number | null; vector_table_name?: string | null } | undefined
      const configuredDimensions = Number(configuredDimensionsRow?.embedding_dimensions || 0)
      const vectorTableName =
        typeof configuredDimensionsRow?.vector_table_name === 'string' && configuredDimensionsRow.vector_table_name.trim().length > 0
          ? configuredDimensionsRow.vector_table_name.trim()
          : 'note_search_vec'

      if (configuredDimensions > 0) {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName} USING vec0(
            message_id TEXT PRIMARY KEY,
            embedding float[${configuredDimensions}],
            user_id TEXT partition key,
            project_id TEXT,
            storage_mode TEXT,
            conversation_id TEXT,
            note_updated_at TEXT
          );
        `)
      }
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS note_search_fts USING fts5(
        message_id UNINDEXED,
        conversation_title,
        note,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)

    db.exec(`
      DROP TRIGGER IF EXISTS note_search_docs_fts_insert;
      DROP TRIGGER IF EXISTS note_search_docs_fts_update;
      DROP TRIGGER IF EXISTS note_search_docs_fts_delete;
      DROP TRIGGER IF EXISTS note_search_docs_from_messages_insert;
      DROP TRIGGER IF EXISTS note_search_docs_from_messages_update;
      DROP TRIGGER IF EXISTS note_search_docs_from_messages_delete;
      DROP TRIGGER IF EXISTS note_search_docs_from_conversations_update;
    `)

    db.exec(`
      CREATE TRIGGER note_search_docs_fts_insert
      AFTER INSERT ON note_search_docs
      BEGIN
        INSERT INTO note_search_fts (message_id, conversation_title, note)
        VALUES (
          NEW.message_id,
          COALESCE(NEW.conversation_title, ''),
          COALESCE(NEW.note, '')
        );
      END;

      CREATE TRIGGER note_search_docs_fts_update
      AFTER UPDATE ON note_search_docs
      BEGIN
        DELETE FROM note_search_fts WHERE message_id = OLD.message_id;
        INSERT INTO note_search_fts (message_id, conversation_title, note)
        VALUES (
          NEW.message_id,
          COALESCE(NEW.conversation_title, ''),
          COALESCE(NEW.note, '')
        );
      END;

      CREATE TRIGGER note_search_docs_fts_delete
      AFTER DELETE ON note_search_docs
      BEGIN
        DELETE FROM note_search_fts WHERE message_id = OLD.message_id;
      END;

      CREATE TRIGGER note_search_docs_from_messages_insert
      AFTER INSERT ON messages
      WHEN LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
      BEGIN
        INSERT INTO note_search_docs (
          message_id,
          conversation_id,
          project_id,
          user_id,
          storage_mode,
          conversation_title,
          note,
          message_created_at,
          note_updated_at
        )
        SELECT
          NEW.id,
          NEW.conversation_id,
          c.project_id,
          c.user_id,
          c.storage_mode,
          c.title,
          NEW.note,
          COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
          CURRENT_TIMESTAMP
        FROM conversations c
        WHERE c.id = NEW.conversation_id
        ON CONFLICT(message_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          project_id = excluded.project_id,
          user_id = excluded.user_id,
          storage_mode = excluded.storage_mode,
          conversation_title = excluded.conversation_title,
          note = excluded.note,
          message_created_at = excluded.message_created_at,
          note_updated_at = excluded.note_updated_at;

        INSERT INTO note_search_embedding_state (
          message_id,
          content_hash,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        ) VALUES (
          NEW.id,
          NULL,
          NULL,
          NULL,
          NULL,
          'pending',
          NULL
        )
        ON CONFLICT(message_id) DO UPDATE SET
          content_hash = NULL,
          embedding_status = CASE
            WHEN note_search_embedding_state.embedding_status = 'ready' THEN 'stale'
            ELSE note_search_embedding_state.embedding_status
          END,
          last_error = NULL;
      END;

      CREATE TRIGGER note_search_docs_from_messages_update
      AFTER UPDATE ON messages
      WHEN COALESCE(OLD.note, '') IS NOT COALESCE(NEW.note, '')
      BEGIN
        DELETE FROM note_search_docs
        WHERE message_id = OLD.id
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) = 0;

        INSERT INTO note_search_docs (
          message_id,
          conversation_id,
          project_id,
          user_id,
          storage_mode,
          conversation_title,
          note,
          message_created_at,
          note_updated_at
        )
        SELECT
          NEW.id,
          NEW.conversation_id,
          c.project_id,
          c.user_id,
          c.storage_mode,
          c.title,
          NEW.note,
          COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
          CURRENT_TIMESTAMP
        FROM conversations c
        WHERE c.id = NEW.conversation_id
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
        ON CONFLICT(message_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          project_id = excluded.project_id,
          user_id = excluded.user_id,
          storage_mode = excluded.storage_mode,
          conversation_title = excluded.conversation_title,
          note = excluded.note,
          message_created_at = excluded.message_created_at,
          note_updated_at = excluded.note_updated_at;

        DELETE FROM note_search_embedding_state
        WHERE message_id = OLD.id
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) = 0;

        INSERT INTO note_search_embedding_state (
          message_id,
          content_hash,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        )
        SELECT
          NEW.id,
          NULL,
          NULL,
          NULL,
          NULL,
          'pending',
          NULL
        WHERE LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0
        ON CONFLICT(message_id) DO UPDATE SET
          content_hash = NULL,
          embedding_status = CASE
            WHEN COALESCE(OLD.note, '') IS COALESCE(NEW.note, '') THEN note_search_embedding_state.embedding_status
            WHEN note_search_embedding_state.embedding_status = 'ready' THEN 'stale'
            ELSE 'pending'
          END,
          last_error = NULL;
      END;

      CREATE TRIGGER note_search_docs_from_messages_delete
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM note_search_docs WHERE message_id = OLD.id;
        DELETE FROM note_search_embedding_state WHERE message_id = OLD.id;
      END;

      CREATE TRIGGER note_search_docs_from_conversations_update
      AFTER UPDATE ON conversations
      BEGIN
        UPDATE note_search_docs
        SET
          project_id = NEW.project_id,
          user_id = NEW.user_id,
          storage_mode = NEW.storage_mode,
          conversation_title = NEW.title,
          note_updated_at = CURRENT_TIMESTAMP
        WHERE conversation_id = NEW.id;
      END;
    `)

    db.exec(`DELETE FROM note_search_docs;`)
    db.exec(`DELETE FROM note_search_fts;`)
    db.exec(`
      INSERT INTO note_search_docs (
        message_id,
        conversation_id,
        project_id,
        user_id,
        storage_mode,
        conversation_title,
        note,
        message_created_at,
        note_updated_at
      )
      SELECT
        m.id,
        m.conversation_id,
        c.project_id,
        c.user_id,
        c.storage_mode,
        c.title,
        m.note,
        COALESCE(m.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      FROM messages m
      INNER JOIN conversations c ON c.id = m.conversation_id
      WHERE LENGTH(TRIM(COALESCE(m.note, ''))) > 0;
    `)

    db.exec(`
      DELETE FROM note_search_embedding_state
      WHERE message_id NOT IN (SELECT message_id FROM note_search_docs);
    `)
    db.exec(`
      INSERT OR IGNORE INTO note_search_embedding_state (
        message_id,
        content_hash,
        embedding_model,
        embedding_dimensions,
        embedding_updated_at,
        embedding_status,
        last_error
      )
      SELECT
        d.message_id,
        NULL,
        NULL,
        NULL,
        NULL,
        'pending',
        NULL
      FROM note_search_docs d;
    `)

    noteSearchFtsAvailable = true
  } catch (noteSearchError) {
    console.warn(
      '[LocalServer] Note search schema/FTS unavailable. Falling back to basic note search.',
      noteSearchError
    )
  }

  if (noteSearchFtsAvailable) {
    console.log('[LocalServer] Note search FTS index ready')
  }

  // Triggers to maintain children_ids integrity
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_children_insert AFTER INSERT ON messages
    WHEN NEW.parent_id IS NOT NULL
    BEGIN
      UPDATE messages
      SET children_ids = (
        SELECT CASE
          WHEN children_ids = '[]' OR children_ids = '' THEN '["' || NEW.id || '"]'
          ELSE SUBSTR(children_ids, 1, LENGTH(children_ids)-1) || ',"' || NEW.id || '"]'
        END
        FROM messages WHERE id = NEW.parent_id
      )
      WHERE id = NEW.parent_id;
    END;
  `)

  // Update statements
  statements = {
    // Content lineages (separate from execution/stream runs)
    insertLineage: db.prepare(`
      INSERT INTO lineages (
        id, conversation_id, parent_lineage_id, forked_from_message_id,
        root_message_id, head_message_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getLineageById: db.prepare('SELECT * FROM lineages WHERE id = ?'),
    listLineagesByConversation: db.prepare(
      'SELECT * FROM lineages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC'
    ),
    resolveLineageByMessage: db.prepare(`
      SELECT l.* FROM messages m INNER JOIN lineages l ON l.id = m.lineage_id WHERE m.id = ?
    `),
    resolveAncestorLineageByMessage: db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id, lineage_id, depth) AS (
        SELECT id, parent_id, lineage_id, 0 FROM messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id, m.lineage_id, ancestors.depth + 1
        FROM messages m INNER JOIN ancestors ON m.id = ancestors.parent_id
        WHERE ancestors.depth < 10000
      )
      SELECT l.* FROM ancestors INNER JOIN lineages l ON l.id = ancestors.lineage_id
      WHERE ancestors.lineage_id IS NOT NULL ORDER BY ancestors.depth ASC LIMIT 1
    `),
    attachMessageToLineage: db.prepare(`
      UPDATE messages SET lineage_id = ?
      WHERE id = ?
        AND conversation_id = (SELECT conversation_id FROM lineages WHERE id = ?)
        AND (lineage_id IS NULL OR lineage_id = ?)
    `),
    advanceLineage: db.prepare(`
      UPDATE lineages SET root_message_id = COALESCE(root_message_id, ?), head_message_id = ?,
        status = ?, updated_at = ? WHERE id = ?
    `),
    insertForkOperation: db.prepare(`
      INSERT INTO fork_operations (
        id, conversation_id, source_lineage_id, target_lineage_id, source_message_id,
        materialized_message_id, operation, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getForkOperationById: db.prepare('SELECT * FROM fork_operations WHERE id = ?'),
    materializeForkOperation: db.prepare(`
      UPDATE fork_operations SET materialized_message_id = ?, status = 'materialized', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    attachStreamingRunToLineage: db.prepare('UPDATE streaming_runs SET lineage_id = ? WHERE stream_id = ?'),
    attachSubagentRunToLineage: db.prepare('UPDATE subagent_runs SET lineage_id = ? WHERE id = ?'),
    // Latest subagent stream for a tool call — the streamId the transcript viewer
    // subscribes to for live progress (a resume mints a newer row, so DESC LIMIT 1
    // always resolves the current attempt).
    getLatestSubagentStreamIdByToolCall: db.prepare(
      "SELECT stream_id FROM streaming_runs WHERE tool_call_id = ? AND stream_type = 'subagent' ORDER BY started_at DESC LIMIT 1"
    ),

    // Metadata-only execution ownership under stable content lineage.
    insertToolInvocation: db.prepare(`
      INSERT INTO tool_invocations (
        id, conversation_id, lineage_id, run_id, parent_tool_invocation_id,
        tool_call_id, assistant_message_id, tool_name, status, started_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `),
    finishToolInvocation: db.prepare(`
      UPDATE tool_invocations SET status = ?, ended_at = ?, duration_ms = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `),
    getToolInvocationById: db.prepare('SELECT * FROM tool_invocations WHERE id = ?'),
    listToolInvocationsByLineage: db.prepare(
      'SELECT * FROM tool_invocations WHERE lineage_id = ? ORDER BY started_at ASC, id ASC'
    ),

    // Users
    upsertUser: db.prepare(`
        INSERT INTO users (id, username, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username
      `),

    // Projects
    upsertProject: db.prepare(`
        INSERT INTO projects (id, name, user_id, context, system_prompt, cwd, storage_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          context = excluded.context,
          system_prompt = excluded.system_prompt,
          cwd = excluded.cwd,
          storage_mode = excluded.storage_mode,
          updated_at = excluded.updated_at
      `),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    getLocalProjects: db.prepare(
      "SELECT * FROM projects WHERE user_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC"
    ),

    // Conversations
    upsertConversation: db.prepare(`
        INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_name = excluded.model_name,
          system_prompt = excluded.system_prompt,
          conversation_context = excluded.conversation_context,
          research_note = excluded.research_note,
          cwd = excluded.cwd,
          storage_mode = excluded.storage_mode,
          updated_at = excluded.updated_at
      `),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
    getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    getAllConversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC'),
    getLocalConversations: db.prepare(
      "SELECT * FROM conversations WHERE user_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC"
    ),
    getLocalConversationsPaginated: db.prepare(
      "SELECT * FROM conversations WHERE user_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ),
    getLocalConversationsByUserAndProject: db.prepare(
      "SELECT * FROM conversations WHERE user_id = ? AND project_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC"
    ),
    getLocalConversationsByUserAndProjectPaginated: db.prepare(
      "SELECT * FROM conversations WHERE user_id = ? AND project_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ),
    getFavoriteConversations: db.prepare(
      'SELECT * FROM conversations WHERE user_id = ? AND favorite = 1 ORDER BY updated_at DESC'
    ),
    getFavoriteConversationsLimited: db.prepare(
      'SELECT * FROM conversations WHERE user_id = ? AND favorite = 1 ORDER BY updated_at DESC LIMIT ?'
    ),
    searchConversationsByTitle: db.prepare(
      `SELECT * FROM conversations
       WHERE user_id = ?
         AND (
           COALESCE(title, '') LIKE ? COLLATE NOCASE
           OR REPLACE(REPLACE(REPLACE(COALESCE(title, ''), ' ', ''), '-', ''), '_', '') LIKE ? COLLATE NOCASE
         )
       ORDER BY updated_at DESC
       LIMIT ?`
    ),
    searchConversationsByTitleInProject: db.prepare(
      `SELECT * FROM conversations
       WHERE user_id = ?
         AND project_id = ?
         AND (
           COALESCE(title, '') LIKE ? COLLATE NOCASE
           OR REPLACE(REPLACE(REPLACE(COALESCE(title, ''), ' ', ''), '-', ''), '_', '') LIKE ? COLLATE NOCASE
         )
       ORDER BY updated_at DESC
       LIMIT ?`
    ),
    updateConversationResearchNote: db.prepare(
      'UPDATE conversations SET research_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ),
    updateConversationCwd: db.prepare('UPDATE conversations SET cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    updateConversationTitle: db.prepare(
      'UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ),
    updateConversationProjectId: db.prepare(
      'UPDATE conversations SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ),
    updateConversationFavorite: db.prepare('UPDATE conversations SET favorite = ? WHERE id = ?'),

    // Messages
    upsertMessage: db.prepare(`
        INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          plain_text_content = excluded.plain_text_content,
          thinking_block = excluded.thinking_block,
          tool_calls = excluded.tool_calls,
          tool_call_id = excluded.tool_call_id,
          note = excluded.note,
          note_color = excluded.note_color,
          content_blocks = excluded.content_blocks
      `),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
    getTopLevelUserMessagesByConversationId: db.prepare(`
      SELECT id, conversation_id, content, plain_text_content, note, note_color, created_at
      FROM messages
      WHERE conversation_id = ?
        AND parent_id IS NULL
        AND role = 'user'
      ORDER BY created_at ASC
    `),
    getLastMessageByConversationId: db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1'
    ),

    // Streaming run lifecycle tracking
    upsertStreamingRun: db.prepare(`
        INSERT INTO streaming_runs (
          stream_id, conversation_id, parent_message_id, user_message_id, assistant_message_id,
          final_message_id, stream_type, status, end_reason, provider, model_name, operation,
          source, root_message_id, origin_message_id, parent_stream_id, tool_call_id, error,
          metadata_json, started_at, ended_at, duration_ms, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stream_id) DO UPDATE SET
          conversation_id = COALESCE(excluded.conversation_id, streaming_runs.conversation_id),
          parent_message_id = COALESCE(excluded.parent_message_id, streaming_runs.parent_message_id),
          user_message_id = COALESCE(excluded.user_message_id, streaming_runs.user_message_id),
          assistant_message_id = COALESCE(excluded.assistant_message_id, streaming_runs.assistant_message_id),
          final_message_id = COALESCE(excluded.final_message_id, streaming_runs.final_message_id),
          stream_type = excluded.stream_type,
          status = excluded.status,
          end_reason = COALESCE(excluded.end_reason, streaming_runs.end_reason),
          provider = COALESCE(excluded.provider, streaming_runs.provider),
          model_name = COALESCE(excluded.model_name, streaming_runs.model_name),
          operation = COALESCE(excluded.operation, streaming_runs.operation),
          source = excluded.source,
          root_message_id = COALESCE(excluded.root_message_id, streaming_runs.root_message_id),
          origin_message_id = COALESCE(excluded.origin_message_id, streaming_runs.origin_message_id),
          parent_stream_id = COALESCE(excluded.parent_stream_id, streaming_runs.parent_stream_id),
          tool_call_id = COALESCE(excluded.tool_call_id, streaming_runs.tool_call_id),
          error = COALESCE(excluded.error, streaming_runs.error),
          metadata_json = COALESCE(excluded.metadata_json, streaming_runs.metadata_json),
          ended_at = COALESCE(excluded.ended_at, streaming_runs.ended_at),
          duration_ms = COALESCE(excluded.duration_ms, streaming_runs.duration_ms),
          updated_at = excluded.updated_at
      `),
    updateStreamingRun: db.prepare(`
        UPDATE streaming_runs
        SET status = COALESCE(?, status),
            end_reason = COALESCE(?, end_reason),
            assistant_message_id = COALESCE(?, assistant_message_id),
            final_message_id = COALESCE(?, final_message_id),
            user_message_id = COALESCE(?, user_message_id),
            error = ?,
            metadata_json = COALESCE(?, metadata_json),
            ended_at = COALESCE(?, ended_at),
            duration_ms = COALESCE(?, duration_ms),
            updated_at = ?
        WHERE stream_id = ?
      `),
    getStreamingRunById: db.prepare('SELECT * FROM streaming_runs WHERE stream_id = ?'),
    getStreamingRunsByConversationId: db.prepare(
      'SELECT * FROM streaming_runs WHERE conversation_id = ? ORDER BY started_at ASC'
    ),
    getActiveStreamingRuns: db.prepare("SELECT * FROM streaming_runs WHERE status = 'running' ORDER BY started_at ASC"),

    // Subagent runs/transcripts
    upsertSubagentRun: db.prepare(`
        INSERT INTO subagent_runs (id, conversation_id, parent_message_id, tool_call_id, prompt, provider, model_name, system_prompt, status, final_response, error, turns_used, tool_calls_used, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          final_response = excluded.final_response,
          error = excluded.error,
          turns_used = excluded.turns_used,
          tool_calls_used = excluded.tool_calls_used,
          updated_at = excluded.updated_at
      `),
    updateSubagentRun: db.prepare(`
        UPDATE subagent_runs
        SET status = COALESCE(?, status),
            final_response = COALESCE(?, final_response),
            error = ?,
            turns_used = COALESCE(?, turns_used),
            tool_calls_used = COALESCE(?, tool_calls_used),
            updated_at = ?
        WHERE id = ?
      `),
    insertSubagentMessage: db.prepare(`
        INSERT INTO subagent_messages (id, run_id, role, content, thinking_block, tool_calls, tool_call_id, content_blocks, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          thinking_block = excluded.thinking_block,
          tool_calls = excluded.tool_calls,
          tool_call_id = excluded.tool_call_id,
          content_blocks = excluded.content_blocks
      `),
    getSubagentRunsByConversationId: db.prepare(
      'SELECT * FROM subagent_runs WHERE conversation_id = ? ORDER BY created_at ASC'
    ),
    getSubagentRunsByParentMessageId: db.prepare(
      'SELECT * FROM subagent_runs WHERE parent_message_id = ? ORDER BY created_at ASC'
    ),
    getSubagentRunById: db.prepare('SELECT * FROM subagent_runs WHERE id = ?'),
    getSubagentRunByHandle: db.prepare('SELECT * FROM subagent_runs WHERE handle = ?'),
    getSubagentRunsByToolCallId: db.prepare(
      'SELECT * FROM subagent_runs WHERE tool_call_id = ? ORDER BY created_at ASC'
    ),
    getSubagentRunsByLineageId: db.prepare(
      'SELECT * FROM subagent_runs WHERE lineage_id = ? ORDER BY created_at ASC'
    ),
    getSubagentRunsByLineageAndStatus: db.prepare(
      'SELECT * FROM subagent_runs WHERE lineage_id = ? AND status = ? ORDER BY created_at ASC'
    ),
    attachSubagentRunHandle: db.prepare('UPDATE subagent_runs SET handle = ? WHERE id = ?'),
    reopenSubagentRun: db.prepare(`
        UPDATE subagent_runs
        SET status = 'running', error = NULL, attempt = attempt + 1, updated_at = ?
        WHERE id = ? AND status IN ('error', 'aborted')
      `),
    getRunningSubagentRuns: db.prepare("SELECT * FROM subagent_runs WHERE status = 'running' ORDER BY created_at ASC"),
    getSubagentMessagesByRunId: db.prepare(
      'SELECT * FROM subagent_messages WHERE run_id = ? ORDER BY sequence ASC, created_at ASC'
    ),
    getNextSubagentMessageSequence: db.prepare(
      'SELECT COALESCE(MAX(sequence), -1) + 1 AS nextSequence FROM subagent_messages WHERE run_id = ?'
    ),

    // Attachments
    upsertAttachment: db.prepare(`
        INSERT INTO message_attachments (id, message_id, kind, mime_type, storage, url, file_path, width, height, size_bytes, sha256, created_at, short_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          url = excluded.url,
          file_path = excluded.file_path,
          short_id = COALESCE(excluded.short_id, message_attachments.short_id)
      `),
    linkAttachment: db.prepare(`
        INSERT OR IGNORE INTO message_attachment_links (id, message_id, attachment_id, created_at)
        VALUES (?, ?, ?, ?)
      `),
    getAttachmentsByMessageId: db.prepare(`
        SELECT ma.*
        FROM message_attachment_links mal
        JOIN message_attachments ma ON ma.id = mal.attachment_id
        WHERE mal.message_id = ?
        ORDER BY ma.created_at ASC
      `),
    getAttachmentById: db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
    getAttachmentBySha256: db.prepare('SELECT * FROM message_attachments WHERE sha256 = ?'),
    getAttachmentByShortId: db.prepare('SELECT * FROM message_attachments WHERE short_id = ?'),

    // Provider Cost
    upsertProviderCost: db.prepare(`
        INSERT INTO provider_cost (id, user_id, message_id, prompt_tokens, completion_tokens, reasoning_tokens, approx_cost, api_credit_cost, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          approx_cost = excluded.approx_cost,
          api_credit_cost = excluded.api_credit_cost
      `),

    // Message updates (for local editing)
    updateMessage: db.prepare('UPDATE messages SET content = ?, note = ?, note_color = ?, content_blocks = ? WHERE id = ?'),
  }

  Object.assign(statements, createToolsStatements(db))
  pruneOldTools(statements)
}



interface ConnectedClient {
  ws: WebSocket
  type: 'extension' | 'frontend'
  id: string
  workspaceName: string | null
  rootPath: string | null
  lastHeartbeat: number
  connectedAt: number
}

const clients = new Set<ConnectedClient>()

// Track extension metadata separately for efficient extension list management
const extensionsMap = new Map<
  string,
  {
    clientId: string
    workspaceName: string | null
    rootPath: string | null
    lastHeartbeat: number
    connectedAt: number
  }
>()

function upsertExtensionMetadata(
  clientId: string,
  data: Partial<{ workspaceName: string | null; rootPath: string | null }>
) {
  const now = Date.now()
  const existing = extensionsMap.get(clientId)
  extensionsMap.set(clientId, {
    clientId,
    workspaceName: data.workspaceName ?? existing?.workspaceName ?? null,
    rootPath: data.rootPath ?? existing?.rootPath ?? null,
    lastHeartbeat: now,
    connectedAt: existing?.connectedAt ?? now,
  })
}

// Broadcast the current extensions overview to all frontend clients
function broadcastExtensionsOverview() {
  const extensionsList = Array.from(extensionsMap.values()).map(ext => ({
    id: ext.clientId,
    workspaceName: ext.workspaceName,
    rootPath: ext.rootPath,
    lastHeartbeat: ext.lastHeartbeat,
    connectedAt: ext.connectedAt,
    isConnected: true,
  }))

  const message = JSON.stringify({
    type: 'extensions_overview',
    data: {
      extensions: extensionsList,
      totalExtensions: extensionsList.length,
      timestamp: new Date().toISOString(),
    },
  })

  clients.forEach(c => {
    if (c.type === 'frontend' && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(message)
    }
  })
}

function initializeWebSocketServer(serverInstance: any) {
  // console.log('[LocalServer] Initializing WebSocket Server on /ide-context')

  wss = new WebSocketServer({ noServer: true })

  serverInstance.on('upgrade', (request: any, socket: any, head: Buffer) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)

    if (url.pathname === '/ide-context') {
      wss!.handleUpgrade(request, socket, head, ws => {
        wss!.emit('connection', ws, request)
      })
      return
    }

    if (handleLspWebSocketUpgrade(request, socket, head)) {
      return
    }
  })

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url!, `http://${request.headers.host}`)
    const clientType = url.searchParams.get('type') as 'extension' | 'frontend'
    const clientId = url.searchParams.get('id') || 'anonymous'

    const now = Date.now()

    const client: ConnectedClient = {
      ws,
      type: clientType || 'frontend',
      id: clientId,
      workspaceName: null,
      rootPath: null,
      lastHeartbeat: now,
      connectedAt: now,
    }

    clients.add(client)

    // If this is an extension, track it in the extensions map
    if (client.type === 'extension') {
      upsertExtensionMetadata(client.id, { workspaceName: null, rootPath: null })
      // Broadcast updated extensions list to frontend clients
      broadcastExtensionsOverview()
    }

    // console.log(`[LocalServer] Client connected: ${client.type} (${client.id})`)

    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString())

        if (message.type === 'ping') {
          client.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }))
          return // don’t broadcast heartbeat traffic
        }

        // Relay messages from extension to all frontend clients
        if (client.type === 'extension') {
          const outgoing = {
            ...message,
            // Normalize requestId to be present at the top-level if available in data
            requestId: message.requestId ?? message.data?.requestId,
            clientId: client.id,
          }

          // Update extension metadata when workspace info is present
          if (message.type === 'project_state_update' || message.type === 'context_response') {
            const projectState = message.data
            const workspaceInfo = projectState?.workspace
            const name = typeof workspaceInfo === 'string' ? workspaceInfo : (workspaceInfo?.name ?? null)
            const rootPath = typeof workspaceInfo === 'string' ? null : (workspaceInfo?.rootPath ?? null)
            upsertExtensionMetadata(client.id, { workspaceName: name, rootPath })
            broadcastExtensionsOverview()
          }

          clients.forEach(c => {
            if (c.type === 'frontend' && c.ws.readyState === WebSocket.OPEN) {
              c.ws.send(JSON.stringify(outgoing))
            }
          })
        }

        // Handle frontend requests to extension
        if (client.type === 'frontend') {
          if (message.type === 'request_context') {
            const extensionClients = Array.from(clients).filter(
              c => c.type === 'extension' && c.ws.readyState === WebSocket.OPEN
            )

            const targetExtensionId = message.data?.extensionId as string | undefined

            clients.forEach(c => {
              if (c.type === 'extension' && c.ws.readyState === WebSocket.OPEN) {
                if (targetExtensionId && c.id !== targetExtensionId) return
                c.ws.send(
                  JSON.stringify({
                    type: 'request_context',
                    requestId: message.requestId,
                  })
                )
              }
            })

            if (extensionClients.length === 0 || (targetExtensionId && !extensionsMap.has(targetExtensionId))) {
              // No extensions available or selected extension not present: respond with empty context
              client.ws.send(
                JSON.stringify({
                  type: 'context_response',
                  requestId: message.requestId,
                  data: {
                    workspace: { name: null, rootPath: null },
                    openFiles: [],
                    allFiles: [],
                    activeFile: null,
                    currentSelection: null,
                  },
                })
              )
            }
          } else if (message.type === 'request_file_content') {
            const targetExtensionId = message.data?.extensionId as string | undefined

            clients.forEach(c => {
              if (c.type === 'extension' && c.ws.readyState === WebSocket.OPEN) {
                if (targetExtensionId && c.id !== targetExtensionId) return
                c.ws.send(
                  JSON.stringify({
                    type: 'request_file_content',
                    requestId: message.requestId,
                    data: {
                      path: message.data.path,
                    },
                  })
                )
              }
            })
          } else if (message.type === 'subscribe_jobs') {
            // Subscribe to tool orchestrator job events
            toolOrchestrator.subscribe(client.ws)
            client.ws.send(
              JSON.stringify({
                type: 'jobs_subscribed',
                timestamp: new Date().toISOString(),
              })
            )
          } else if (message.type === 'unsubscribe_jobs') {
            // Unsubscribe from tool orchestrator job events
            toolOrchestrator.unsubscribe(client.ws)
            client.ws.send(
              JSON.stringify({
                type: 'jobs_unsubscribed',
                timestamp: new Date().toISOString(),
              })
            )
          }
        }
      } catch (error) {
        console.error('[LocalServer] Failed to parse WebSocket message:', error)
      }
    })

    ws.on('close', () => {
      clients.delete(client)
      if (client.type === 'extension') {
        extensionsMap.delete(client.id)
        broadcastExtensionsOverview()
      }
      // console.log(`[LocalServer] Client disconnected: ${client.type} (${client.id})`)
    })

    ws.on('error', error => {
      console.error(`[LocalServer] WebSocket error for ${client.type}:`, error)
      clients.delete(client)
      if (client.type === 'extension') {
        extensionsMap.delete(client.id)
        broadcastExtensionsOverview()
      }
    })
  })
}

// Setup Express app
function setupServer() {
  const corsPolicy = tryGetServerConfig()?.cors ?? { mode: 'permissive' as const, allowedOrigins: [] }
  app.use(
    cors({
      origin: buildCorsOriginOption(corsPolicy),
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-api-key',
        'x-tenant-id',
        'x-tool-name',
        'x-tool-id',
        'x-session-id',
        'x-proxy-admin-key',
        'x-app-store-filename',
      ],
      exposedHeaders: ['Authorization'],
    })
  )
  app.use(express.json({ limit: '25mb' }))

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'local-sync' })
  })

  if (db) {
    registerToolsRoutes(app, db, statements)
    registerHeadlessServerRoutes(app, { db, statements, orchestrator: toolOrchestrator })
  }
  registerProxyRoutes(app)
  registerLocalOperationsRoutes(app)
  registerSkillRoutes(app)
  registerMcpRoutes(app)
  registerLspRoutes(app)

  // OpenAI ChatGPT OAuth endpoints + callback-server lifecycle live in
  // routes/openaiOAuthRoutes.ts.
  registerOpenAiOAuthRoutes(app)

  // Streaming-run + subagent-run persistence routes live in routes/runStateRoutes.ts.
  registerRunStateRoutes(app, { statements })

  // Sync + local attachment storage routes live in routes/syncStorageRoutes.ts.
  registerSyncStorageRoutes(app, { db: db!, statements, getCurrentDbPath: () => currentDbPath })

  // Memory routes + the memory_manage tool live in routes/memoryRoutes.ts.
  registerMemoryRoutes(app, { statements, builtInTools })

  registerHookRoutes(app)

  registerUndoRoutes(app)

  // Tool execution + custom-tool management routes live in routes/toolExecutionRoutes.ts.
  registerToolExecutionRoutes(app, {
    builtInTools,
    getToolSandbox: () => toolSandbox,
    isUtilityRuntimeFallbackDisabled,
    shouldUseUtilityRuntimeForCustomTool,
  })

  // App-store + restart routes live in routes/appStoreRoutes.ts.
  registerAppStoreRoutes(app)

  // Job management routes live in routes/jobRoutes.ts.
  registerJobRoutes(app)

  // [Phase 1] App automation routes moved to electron/headlessServer/routes/appAutomationRoutes.ts.

  // Stats + analytics dashboard routes live in routes/analyticsRoutes.ts.
  registerAnalyticsRoutes(app, { db: db!, getCurrentDbPath: () => currentDbPath })

  // Conversation-meta, user, and project routes live in routes/userProjectRoutes.ts.
  registerUserProjectRoutes(app, { db: db!, statements })

  // Note/conversation search engine + routes live in routes/noteSearchRoutes.ts.
  const noteSearch = registerNoteSearchRoutes(app, {
    db: db!,
    statements,
    getSqliteVecAvailable: () => sqliteVecAvailable,
    getSqliteVecLoadError: () => sqliteVecLoadError,
  })
  searchNotesForToolRegistry = noteSearch.searchNotes
  searchTopLevelUserMessagesForToolRegistry = noteSearch.searchTopLevelUserMessages

  // Conversation + message CRUD routes live in routes/conversationRoutes.ts.
  // Registered after the note-search routes so /search* wins over /:id.
  registerConversationRoutes(app, { db: db!, statements })

  // ============================================================================
  // CLAUDE CODE AGENT ENDPOINTS
  // ============================================================================

  // Normalize CC SDK content blocks to ChatMessage format
  // CC SDK uses: { type: 'text', text: string }, { type: 'thinking', thinking: string }
  // ChatMessage expects: { type: 'text', content: string, index: number }, { type: 'thinking', content: string, index: number }
  function normalizeContentBlocksForStorage(blocks: any[]): any[] {
    return blocks.map((block, index) => {
      if (block.type === 'text') {
        return {
          type: 'text',
          index,
          content: block.text || block.content || '',
        }
      } else if (block.type === 'thinking') {
        return {
          type: 'thinking',
          index,
          content: block.thinking || block.content || '',
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          index,
          id: block.id,
          name: block.name,
          input: block.input,
        }
      } else if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          index,
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.isError || block.is_error || false,
        }
      }
      // Pass through unknown block types with index added
      return { ...block, index }
    })
  }


  // [Phase 0] Duplicate legacy /api/app/* block removed.
  // Canonical app automation routes are defined earlier in setupServer().

  // Start the OAuth callback server (port 1455 by default). Hosts that do not
  // enable OAuth (standalone default) skip the listener entirely.
  const oauthEnabled = tryGetServerConfig()?.oauth.enabled ?? true
  if (oauthEnabled) {
    startOpenAiOAuthCallbackServer()
  } else {
    console.log('[OAuthServer] OAuth callback server disabled by host configuration')
  }
}

export interface LocalServerStartOptions {
  preferredPort?: number
  fallbackPorts?: number[]
  host?: string
  allowEphemeralPort?: boolean
  dbPath?: string
}

export interface LocalServerStartResult {
  port: number
  host: string
  url: string
  dbPath: string
}

function normalizePortCandidate(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`[LocalServer] Invalid ${label}: ${value}`)
  }
  return value
}

function buildPortCandidates(preferredPort: number, fallbackPorts: number[], allowEphemeralPort: boolean): number[] {
  const candidates: number[] = []
  const seen = new Set<number>()

  const addCandidate = (port: number) => {
    if (seen.has(port)) return
    seen.add(port)
    candidates.push(port)
  }

  addCandidate(preferredPort)
  for (const port of fallbackPorts) {
    addCandidate(port)
  }
  if (allowEphemeralPort) {
    addCandidate(0)
  }

  return candidates
}

function getServerAddressInfo(serverInstance: any): AddressInfo {
  const address = serverInstance.address()
  if (!address || typeof address === 'string') {
    throw new Error('[LocalServer] Unable to resolve bound server address')
  }
  return address
}

function listenOnPort(port: number, host: string): Promise<{ serverInstance: any; actualPort: number }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      candidateServer.removeListener('error', onError)
      candidateServer.removeListener('listening', onListening)
    }

    const onError = (err: NodeJS.ErrnoException) => {
      cleanup()
      reject(err)
    }

    const onListening = () => {
      cleanup()
      try {
        const address = getServerAddressInfo(candidateServer)
        resolve({ serverInstance: candidateServer, actualPort: address.port })
      } catch (error) {
        candidateServer.close(() => {
          reject(error)
        })
      }
    }

    const candidateServer = app.listen(port, host, onListening)
    candidateServer.once('error', onError)
  })
}

// Start the server. Supports legacy signature: startLocalServer(port, dbPath)
export async function startLocalServer(
  optionsOrPort: LocalServerStartOptions | number = 3002,
  legacyDbPath?: string
): Promise<LocalServerStartResult> {
  const defaultDbPath = path.join(process.cwd(), 'data', 'local-sync.db')

  const preferredPort =
    typeof optionsOrPort === 'number'
      ? normalizePortCandidate(optionsOrPort, 'preferred port')
      : normalizePortCandidate(optionsOrPort.preferredPort ?? 3002, 'preferred port')
  const fallbackPortsRaw = typeof optionsOrPort === 'number' ? [] : optionsOrPort.fallbackPorts || []
  const fallbackPorts = fallbackPortsRaw.map((port, index) =>
    normalizePortCandidate(port, `fallback port at index ${index}`)
  )
  const host = typeof optionsOrPort === 'number' ? '127.0.0.1' : optionsOrPort.host || '127.0.0.1'
  const allowEphemeralPort = typeof optionsOrPort === 'number' ? false : (optionsOrPort.allowEphemeralPort ?? false)
  const actualDbPath =
    typeof optionsOrPort === 'number' ? legacyDbPath || defaultDbPath : optionsOrPort.dbPath || defaultDbPath

  if (server && server.listening) {
    const existing = getServerAddressInfo(server)
    return {
      port: existing.port,
      host,
      url: `http://${host}:${existing.port}`,
      dbPath: actualDbPath,
    }
  }

  try {
    // Fail fast when the composition root did not run: every start must go
    // through createYggServer (or a host adapter that configured the host).
    getHostCapabilities()

    // Fresh Express app per start so a stop/start cycle cannot accumulate
    // duplicate middleware/routes on the previous instance.
    app = express()

    initializeLocalDatabase(actualDbPath)
    // Register memory routes and their list-only tool handler before tool registries consume builtInTools.
    setupServer()

    // Initialize tool registries
    initializeBuiltInToolRegistry()
    await customToolRegistry.initialize()

    utilityRuntimeAvailable = false
    toolSandbox = getHostCapabilities().toolSandbox
    if (getToolRuntimeMode() === 'utility') {
      if (!toolSandbox) {
        const message =
          '[LocalServer] Tool runtime mode is "utility" but the host supplied no tool sandbox capability'
        if (isUtilityRuntimeFallbackDisabled()) {
          throw new Error(message)
        }
        console.error(`${message}; falling back to local tools`)
      } else {
        try {
          const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()
          process.env.YGG_CUSTOM_TOOLS_DIRECTORY = path.dirname(customToolsDir)
        } catch (error) {
          console.warn('[LocalServer] Failed to derive custom tools directory override for utility runtime:', error)
        }

        try {
          await toolSandbox.initialize()
          utilityRuntimeAvailable = true
          console.log('[LocalServer] Utility tool runtime enabled')

          try {
            const syncResult = await toolSandbox.reloadCustomTools('startup_sync')
            console.log(
              `[LocalServer] Utility runtime custom tools startup sync complete; total=${syncResult.totalCount ?? 'unknown'} durationMs=${
                syncResult.durationMs ?? 'n/a'
              }`
            )
          } catch (syncError) {
            console.warn('[LocalServer] Utility runtime custom tools startup sync failed:', syncError)
          }
        } catch (error) {
          utilityRuntimeAvailable = false
          if (isUtilityRuntimeFallbackDisabled()) {
            throw error instanceof Error ? error : new Error(String(error))
          }
          console.error('[LocalServer] Failed to initialize utility tool runtime; falling back to local tools:', error)
        }
      }
    }
    await skillRegistry.initialize()
    await mcpManager.initialize()

    // Initialize tool orchestrator with database and register tools
    toolOrchestrator.initialize(db!)

    if (utilityRuntimeAvailable && toolSandbox) {
      const sandbox = toolSandbox
      for (const [toolName, handler] of builtInTools.entries()) {
        toolOrchestrator.registerTool(toolName, async (args, options) => {
          if (shouldUseUtilityRuntimeForTool(toolName)) {
            try {
              return await sandbox.executeTool(toolName, args, options)
            } catch (utilityError) {
              if (isUtilityRuntimeFallbackDisabled()) {
                throw utilityError
              }
              console.warn(
                `[LocalServer] Utility runtime failed for orchestrator tool ${toolName}; falling back to local execution:`,
                utilityError
              )
              return await handler(args, options)
            }
          }
          return await handler(args, options)
        })
      }
      console.log(`[LocalServer] Registered ${builtInTools.size} built-in tools with utility runtime`)
    } else {
      toolOrchestrator.registerTools(builtInTools)
    }

    bindCustomToolsLifecycleListener()

    // Register custom tools with the orchestrator
    registerCustomToolsWithOrchestrator()

    // Register MCP tools with the orchestrator
    try {
      const mcpTools = mcpManager.getAllTools()
      console.log(`[LocalServer] Found ${mcpTools.length} MCP tools to register`)
      for (const mcpTool of mcpTools) {
        const qualifiedName = mcpTool.qualifiedName || mcpTool.name
        console.log(`[LocalServer] Registering MCP tool: ${qualifiedName}`)
        toolOrchestrator.registerTool(qualifiedName, async (args, _options) => {
          try {
            const mcpResult = await mcpManager.callTool(qualifiedName, args)
            // A tool-level failure reported BY a reachable MCP server (isError: true) is a
            // legitimate, model-visible result and still resolves — only a transport-level
            // failure (below) is an execution error.
            return toMcpExecutionResult(mcpResult)
          } catch (error) {
            // MUST rethrow. Resolving with { success: false } made the orchestrator mark the
            // job COMPLETE, so every MCP transport failure (server disconnected, stdio process
            // dead, HTTP endpoint down, OAuth expired, MCP's own request timeout) surfaced as a
            // successful tool result with is_error: false. Throwing turns it into a genuine
            // failed job -> is_error tool result, and gives a retry policy something to hook.
            console.error(`[LocalServer] MCP tool execution error (${qualifiedName}):`, error)
            throw attachChatErrorCode(
              error instanceof Error ? error : new Error(String(error)),
              'mcp_unavailable'
            )
          }
        })
      }
      console.log(`[LocalServer] Registered ${mcpTools.length} MCP tools with orchestrator`)
    } catch (error) {
      console.error(`[LocalServer] Error registering MCP tools:`, error)
    }

    const retryableCodes = new Set(['EADDRINUSE', 'EACCES', 'EPERM'])
    const portCandidates = buildPortCandidates(preferredPort, fallbackPorts, allowEphemeralPort)
    let lastError: Error | null = null

    for (const candidatePort of portCandidates) {
      try {
        const { serverInstance, actualPort } = await listenOnPort(candidatePort, host)
        server = serverInstance

        // Initialize WebSocket Server after HTTP server is running
        initializeWebSocketServer(server)
        initializeLspLocalServer(server)

        const serverUrl = `http://${host}:${actualPort}`
        if (candidatePort !== preferredPort) {
          console.warn(`[LocalServer] Preferred port ${preferredPort} unavailable, using ${actualPort}`)
        }

        return {
          port: actualPort,
          host,
          url: serverUrl,
          dbPath: actualDbPath,
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        lastError = err
        const code = err.code || 'UNKNOWN'
        const portLabel = candidatePort === 0 ? 'ephemeral port' : `port ${candidatePort}`

        if (retryableCodes.has(code)) {
          console.warn(`[LocalServer] Could not bind ${portLabel} (${code}), trying next candidate`)
          continue
        }

        throw error
      }
    }

    const attempted = portCandidates.map(port => (port === 0 ? 'ephemeral' : String(port))).join(', ')
    const message = `[LocalServer] Failed to bind local server after trying: ${attempted}. Last error: ${
      lastError?.message || 'unknown error'
    }`
    throw new Error(message)
  } catch (error) {
    console.error('[LocalServer] Failed to start:', error)
    await stopLocalServer().catch(stopError => {
      console.error('[LocalServer] Cleanup after failed start encountered an error:', stopError)
    })
    throw error
  }
}

// Stop the server
export async function stopLocalServer(): Promise<void> {
  // Shutdown tool orchestrator first
  localAnalyticsWorkerClient.shutdown()
  toolOrchestrator.shutdown()
  customToolRegistry.shutdown()
  utilityRuntimeAvailable = false
  const sandbox = toolSandbox
  toolSandbox = null
  if (sandbox) {
    await sandbox.shutdown().catch(error => {
      console.error('[LocalServer] Failed to shutdown utility tool runtime:', error)
    })
  }

  // Stop the OAuth cleanup timer and close the callback server
  stopOpenAiOAuth()

  return new Promise(resolve => {

    const finalizeWithoutServer = () => {
      if (db) {
        db.close()
        db = null
      }
      currentDbPath = null
      clients.clear()
      extensionsMap.clear()
      wss = null
      resolve()
    }

    const closeIdeContextWebSocketServer = () => {
      if (!wss) return
      wss.close(() => {
        console.log('[LocalServer] WebSocket server closed')
      })
      wss = null
      clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close()
        }
      })
      clients.clear()
      extensionsMap.clear()
    }

    shutdownLspLocalServer()
      .catch(error => {
        console.error('[LocalServer] Failed to shutdown LSP local server:', error)
      })
      .finally(() => {
        if (server) {
          closeIdeContextWebSocketServer()
          server.close(() => {
            console.log('[LocalServer] Server stopped')
            if (db) {
              db.close()
              db = null
            }
            server = null
            currentDbPath = null
            resolve()
          })
          return
        }

        finalizeWithoutServer()
      })
  })
}

// Export for direct usage
export { app, db }


