// electron/server/standaloneEntry.ts
// Standalone Node entrypoint for the Ygg server. No Electron anywhere in this
// graph — the build fails if any reachable module imports 'electron'.
//
// Environment contract (all optional except YGG_DATA_DIR):
//   YGG_HOST                     bind host, default 127.0.0.1 (loopback only;
//                                non-loopback requires YGG_ALLOW_NON_LOOPBACK_BIND)
//   YGG_PORT                     preferred port, default 3002
//   YGG_FALLBACK_PORTS           comma-separated fallback ports, default 3003-3015
//   YGG_ALLOW_EPHEMERAL_PORT     default on; set 0/false to disable
//   YGG_DATA_DIR                 required. Root for db/settings/skills/mcp/todos
//   YGG_DB_PATH                  default <YGG_DATA_DIR>/local-sync.db
//   YGG_TEMP_DIR                 default os.tmpdir()/ygg-server
//   YGG_RESOURCES_DIR            default: directory of this bundle
//   YGG_PROMPTS_DIR              default <resources>/prompts
//   YGG_OAUTH_CALLBACK_ENABLED   default off
//   YGG_OAUTH_CALLBACK_PORT      default 1455
//   YGG_CORS_ALLOWED_ORIGINS     comma-separated allowlist (development only);
//                                unset = loopback-only CORS
//   YGG_ALLOW_NON_LOOPBACK_BIND  development-only escape hatch
//   YGG_TOOLS_RUNTIME            'utility' (default) | 'local'
//   YGG_TOOL_RUNTIME_FALLBACK    default off. On = a sandbox failure re-runs the
//                                tool in-process (NOT recommended)

// Load .env candidates before any module captures environment values.
import '../envLoader.js'

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { NodeToolRuntimeHost } from '../tools/runtime/nodeToolRuntimeHost.js'
import { createYggServer } from './createYggServer.js'
import type { YggHostCapabilities } from './hostCapabilities.js'
import { createNodeFileConfigStore, createNodeFileSecretStore } from './nodeStores.js'
import { resolveYggServerConfig } from './serverConfig.js'

const bundleDir = path.dirname(fileURLToPath(import.meta.url))

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim())
}

function isEnvFalsy(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value ?? '').trim())
}

function parsePort(value: string | undefined, label: string, fallback: number): number {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`[YggServer] ${label} must be an integer in [0, 65535]; got "${trimmed}"`)
  }
  return parsed
}

function parsePortList(value: string | undefined, fallback: number[]): number[] {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return fallback
  return trimmed
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map((entry, index) => parsePort(entry, `fallback port at index ${index}`, NaN))
}

function ensureDirectory(dirPath: string, label: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    fs.accessSync(dirPath, fs.constants.W_OK)
  } catch (error) {
    throw new Error(
      `[YggServer] ${label} "${dirPath}" is not usable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function main(): Promise<void> {
  const dataDirRaw = process.env.YGG_DATA_DIR?.trim()
  if (!dataDirRaw) {
    console.error('[YggServer] YGG_DATA_DIR is required. Set it to a writable directory for server data.')
    process.exit(1)
    return
  }

  const dataDir = path.resolve(dataDirRaw)
  const tempDir = path.resolve(process.env.YGG_TEMP_DIR?.trim() || path.join(os.tmpdir(), 'ygg-server'))
  const resourcesDir = path.resolve(process.env.YGG_RESOURCES_DIR?.trim() || bundleDir)
  const promptsDir = path.resolve(process.env.YGG_PROMPTS_DIR?.trim() || path.join(resourcesDir, 'prompts'))

  ensureDirectory(dataDir, 'YGG_DATA_DIR')
  ensureDirectory(tempDir, 'YGG_TEMP_DIR')

  const toolRuntimeMode = process.env.YGG_TOOLS_RUNTIME?.trim().toLowerCase() === 'local' ? 'local' : 'utility'
  const allowedOrigins = (process.env.YGG_CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

  const config = resolveYggServerConfig({
    bindHost: process.env.YGG_HOST?.trim() || '127.0.0.1',
    preferredPort: parsePort(process.env.YGG_PORT, 'YGG_PORT', 3002),
    fallbackPorts: parsePortList(process.env.YGG_FALLBACK_PORTS, Array.from({ length: 13 }, (_, i) => 3003 + i)),
    allowEphemeralPort: !isEnvFalsy(process.env.YGG_ALLOW_EPHEMERAL_PORT),
    dataDir,
    tempDir,
    dbPath: process.env.YGG_DB_PATH?.trim() || undefined,
    resourcesDir,
    promptsDir,
    cors: allowedOrigins.length > 0 ? { mode: 'allowlist', allowedOrigins } : { mode: 'loopback', allowedOrigins: [] },
    oauth: {
      enabled: isEnvTruthy(process.env.YGG_OAUTH_CALLBACK_ENABLED),
      callbackHost: '127.0.0.1',
      callbackPort: parsePort(process.env.YGG_OAUTH_CALLBACK_PORT, 'YGG_OAUTH_CALLBACK_PORT', 1455),
    },
    toolRuntime: {
      mode: toolRuntimeMode,
      allowInProcessFallback: isEnvTruthy(process.env.YGG_TOOL_RUNTIME_FALLBACK),
    },
    allowNonLoopbackBind: isEnvTruthy(process.env.YGG_ALLOW_NON_LOOPBACK_BIND),
  })

  // Existing consumers of the desktop env conventions (managedToolPaths in the
  // sandbox child, generated-images dir) resolve from these when set.
  process.env.YGG_APP_USER_DATA = process.env.YGG_APP_USER_DATA || config.dataDir

  const settingsFilePath = path.join(config.dataDir, 'ygg-server-settings.json')
  const capabilities: YggHostCapabilities = {
    // restart / openExternal / browserEngine intentionally absent: this host
    // cannot relaunch itself, open a browser, or drive one. Dependent routes
    // return 501 and browse_web is omitted from the advertised tool list.
    configStore: createNodeFileConfigStore(settingsFilePath),
    secretStore: createNodeFileSecretStore(settingsFilePath),
    toolSandbox: config.toolRuntime.mode === 'utility' ? new NodeToolRuntimeHost() : null,
  }

  const handle = await createYggServer(config, capabilities)

  console.log(
    `[YggServer] ready bind=${handle.bindHost}:${handle.port} origin=${handle.origin} db=${handle.dbPath} ` +
      `dataDir=${config.dataDir} toolRuntime=${config.toolRuntime.mode} ` +
      `sandboxFallback=${config.toolRuntime.allowInProcessFallback ? 'on' : 'off'} oauth=${config.oauth.enabled ? 'on' : 'off'}`
  )

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.error(`[YggServer] Received ${signal} during shutdown; exiting immediately`)
      process.exit(1)
      return
    }
    shuttingDown = true
    console.log(`[YggServer] Received ${signal}; closing`)

    const timeout = setTimeout(() => {
      console.error('[YggServer] Shutdown timed out after 15s; exiting nonzero')
      process.exit(1)
    }, 15_000)
    timeout.unref()

    handle
      .close()
      .then(() => {
        clearTimeout(timeout)
        console.log('[YggServer] Closed cleanly')
        process.exit(0)
      })
      .catch(error => {
        clearTimeout(timeout)
        console.error('[YggServer] Shutdown error:', error)
        process.exit(1)
      })
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(error => {
  console.error('[YggServer] Fatal startup error:', error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
