// electron/electronHostAdapter.ts
// Electron implementation of the server host contracts. This file may import
// `electron`; the server graph itself may not. main.ts uses these builders to
// hand createYggServer its config and capabilities.

import Conf from 'conf'
import { app, shell } from 'electron'
import path from 'path'
import type { KeyValueStore, SecretStore, YggHostCapabilities } from './server/hostCapabilities.js'
import { resolveYggServerConfig, type YggServerConfig } from './server/serverConfig.js'
import { browseWeb } from './tools/browseWeb.js'
import { UtilityToolRuntimeHost } from './tools/runtime/UtilityToolRuntimeHost.js'

export interface ElectronServerOptions {
  bindHost: string
  preferredPort: number
  fallbackPorts: number[]
  allowEphemeralPort: boolean
  advertisedOrigin?: string
}

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim())
}

/**
 * Desktop server config. Values preserve current behavior exactly:
 * permissive CORS (the Electron renderer is cross-origin), OAuth callback on
 * 1455, tool runtime mode from YGG_TOOLS_RUNTIME, in-process fallback unless
 * DISABLE_TOOL_RUNTIME_FALLBACK, and non-loopback bind allowed because the
 * guarded LAN/mobile mode is an existing desktop feature.
 */
export function buildElectronServerConfig(options: ElectronServerOptions): YggServerConfig {
  const userDataDir = app.getPath('userData')
  return resolveYggServerConfig({
    bindHost: options.bindHost,
    preferredPort: options.preferredPort,
    fallbackPorts: options.fallbackPorts,
    allowEphemeralPort: options.allowEphemeralPort,
    advertisedOrigin: options.advertisedOrigin,
    dataDir: userDataDir,
    tempDir: app.getPath('temp'),
    dbPath: path.join(userDataDir, 'local-sync.db'),
    resourcesDir: app.isPackaged ? process.resourcesPath : app.getAppPath(),
    cors: { mode: 'permissive', allowedOrigins: [] },
    oauth: { enabled: true, callbackHost: '127.0.0.1', callbackPort: 1455 },
    toolRuntime: {
      mode: process.env.YGG_TOOLS_RUNTIME?.trim().toLowerCase() === 'utility' ? 'utility' : 'local',
      allowInProcessFallback: !isEnvTruthy(process.env.DISABLE_TOOL_RUNTIME_FALLBACK),
    },
    allowNonLoopbackBind: true,
  })
}

function createConfStore(): Conf {
  return new Conf({ projectName: 'ygg-chat-r', configFileMode: 0o600 })
}

function buildConfigStore(): KeyValueStore {
  const store = createConfStore()
  return {
    get: key => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
    delete: key => {
      store.delete(key as never)
    },
  }
}

/**
 * Secrets live in the same Conf store under a dedicated prefix. No server
 * module consumes SecretStore yet (electronAppAuth reads its legacy keys
 * through the config store); this exists so capability wiring is complete.
 */
function buildSecretStore(): SecretStore {
  const store = createConfStore()
  const prefixed = (key: string) => `secrets.${key}`
  return {
    getSecret: async key => {
      const value = store.get(prefixed(key))
      return typeof value === 'string' ? value : null
    },
    setSecret: async (key, value) => {
      store.set(prefixed(key), value)
    },
    deleteSecret: async key => {
      store.delete(prefixed(key) as never)
    },
  }
}

export function buildElectronHostCapabilities(): YggHostCapabilities {
  return {
    restart: async () => {
      app.relaunch()
      app.exit(0)
    },
    openExternal: async url => {
      await shell.openExternal(url)
    },
    configStore: buildConfigStore(),
    secretStore: buildSecretStore(),
    toolSandbox: new UtilityToolRuntimeHost(),
    browserEngine: {
      browse: (url, options) => browseWeb(url, options as Parameters<typeof browseWeb>[1]),
    },
  }
}
