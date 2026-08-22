// server/server/serverConfig.ts
// Runtime-neutral server configuration for the Ygg local server.
//
// This module is part of the host-neutral server graph. It must not import
// `electron` or any module that does. Both hosts build one of these configs:
//   - the Electron adapter derives values from `app.getPath(...)` in main.ts;
//   - the standalone CLI derives values from YGG_* environment variables.

import path from 'path'

export interface YggServerCorsConfig {
  /**
   * permissive — reflect any origin with credentials. This is the legacy
   *   desktop behavior. The Electron renderer calls the server cross-origin
   *   (app://, http://localhost:5173 in dev), so the desktop adapter keeps it.
   * loopback — reflect only loopback origins. Standalone default.
   * allowlist — reflect only origins listed in `allowedOrigins`.
   */
  mode: 'permissive' | 'loopback' | 'allowlist'
  allowedOrigins: string[]
}

export interface YggServerOAuthConfig {
  /** Start the dedicated OAuth callback listener (port 1455 by default). */
  enabled: boolean
  callbackHost: string
  callbackPort: number
}

export interface YggToolRuntimeConfig {
  /**
   * utility — run whitelisted built-in tools and all custom tools in an
   *   out-of-process sandbox (the current YGG_TOOLS_RUNTIME=utility behavior).
   * local — run every tool in the server process.
   */
  mode: 'local' | 'utility'
  /**
   * When the sandbox fails, `true` re-runs the tool in-process (legacy desktop
   * fallback). Standalone must keep this `false`: a sandbox failure fails the
   * tool call instead of executing bash/edit_file inside the server process.
   */
  allowInProcessFallback: boolean
}

export interface YggServerConfig {
  /** Interface the HTTP listener binds. Loopback unless allowNonLoopbackBind. */
  bindHost: string
  preferredPort: number
  fallbackPorts: number[]
  allowEphemeralPort: boolean
  /** Origin advertised to clients when it differs from bindHost (e.g. 0.0.0.0). */
  advertisedOrigin?: string
  /** Root for user data: database, memory files, todos, skills, MCP config. */
  dataDir: string
  /** Root for scratch/staging files (zip extraction, app-store installs). */
  tempDir: string
  dbPath: string
  /** Root for read-only bundled assets (theme templates, packaged resources). */
  resourcesDir: string
  /**
   * Directory holding the operation-mode prompt markdown files
   * (default_chat_mode.md, default_agent_mode.md, default_subagent_mode.md).
   * Optional: when unset, the legacy source-tree candidates are used.
   */
  promptsDir?: string
  cors: YggServerCorsConfig
  oauth: YggServerOAuthConfig
  toolRuntime: YggToolRuntimeConfig
  /**
   * Development-only escape hatch. Phase 1 rejects non-loopback binds for the
   * standalone server unless this is set explicitly. The Electron adapter sets
   * it for the existing guarded LAN/mobile mode.
   */
  allowNonLoopbackBind: boolean
}

export interface YggServerConfigInput {
  bindHost?: string
  preferredPort?: number
  fallbackPorts?: number[]
  allowEphemeralPort?: boolean
  advertisedOrigin?: string
  dataDir: string
  tempDir: string
  dbPath?: string
  resourcesDir: string
  promptsDir?: string
  cors?: Partial<YggServerCorsConfig>
  oauth?: Partial<YggServerOAuthConfig>
  toolRuntime?: Partial<YggToolRuntimeConfig>
  allowNonLoopbackBind?: boolean
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (LOOPBACK_HOSTS.has(normalized)) return true
  // 127.0.0.0/8
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

function normalizePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`[YggServerConfig] Invalid ${label}: ${value}`)
  }
  return value
}

function requireDirectory(value: string | undefined, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    throw new Error(`[YggServerConfig] ${label} is required and must be a non-empty path`)
  }
  return path.resolve(trimmed)
}

/**
 * Validate and normalize a config input into a complete YggServerConfig.
 * Throws with an actionable message on invalid input. Performs no filesystem
 * access; directory creation/verification is the entrypoint's responsibility.
 */
export function resolveYggServerConfig(input: YggServerConfigInput): YggServerConfig {
  const bindHost = (input.bindHost ?? '127.0.0.1').trim()
  if (!bindHost) {
    throw new Error('[YggServerConfig] bindHost must be a non-empty host')
  }

  const allowNonLoopbackBind = input.allowNonLoopbackBind ?? false
  if (!isLoopbackHost(bindHost) && !allowNonLoopbackBind) {
    throw new Error(
      `[YggServerConfig] Refusing non-loopback bind host "${bindHost}". ` +
        'The Phase 1 server is unauthenticated; set allowNonLoopbackBind ' +
        '(YGG_ALLOW_NON_LOOPBACK_BIND=1 for the standalone CLI) only for guarded development use.'
    )
  }

  const preferredPort = normalizePort(input.preferredPort ?? 3002, 'preferred port')
  const fallbackPorts = (input.fallbackPorts ?? []).map((port, index) =>
    normalizePort(port, `fallback port at index ${index}`)
  )

  const dataDir = requireDirectory(input.dataDir, 'dataDir')
  const tempDir = requireDirectory(input.tempDir, 'tempDir')
  const resourcesDir = requireDirectory(input.resourcesDir, 'resourcesDir')
  const dbPath = input.dbPath ? path.resolve(input.dbPath.trim()) : path.join(dataDir, 'local-sync.db')
  const promptsDir = input.promptsDir ? path.resolve(input.promptsDir.trim()) : undefined

  const corsMode = input.cors?.mode ?? 'loopback'
  const allowedOrigins = (input.cors?.allowedOrigins ?? []).map(origin => origin.trim()).filter(Boolean)
  if (corsMode === 'allowlist' && allowedOrigins.length === 0) {
    throw new Error('[YggServerConfig] cors.mode "allowlist" requires at least one allowed origin')
  }

  const oauthEnabled = input.oauth?.enabled ?? false
  const oauthCallbackHost = (input.oauth?.callbackHost ?? '127.0.0.1').trim()
  const oauthCallbackPort = normalizePort(input.oauth?.callbackPort ?? 1455, 'oauth callback port')

  const toolRuntimeMode = input.toolRuntime?.mode ?? 'utility'
  const allowInProcessFallback = input.toolRuntime?.allowInProcessFallback ?? false

  return {
    bindHost,
    preferredPort,
    fallbackPorts,
    allowEphemeralPort: input.allowEphemeralPort ?? false,
    advertisedOrigin: input.advertisedOrigin?.trim() || undefined,
    dataDir,
    tempDir,
    dbPath,
    resourcesDir,
    promptsDir,
    cors: { mode: corsMode, allowedOrigins },
    oauth: { enabled: oauthEnabled, callbackHost: oauthCallbackHost, callbackPort: oauthCallbackPort },
    toolRuntime: { mode: toolRuntimeMode, allowInProcessFallback },
    allowNonLoopbackBind,
  }
}
