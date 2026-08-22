// server/server/createYggServer.ts
// Composition root for the Ygg local server.
//
// Both hosts call this factory:
//   - electron/main.ts builds config/capabilities from Electron app paths;
//   - electron/server/standaloneEntry.ts builds them from YGG_* env vars.
//
// The factory installs the host context, starts the server graph, and returns
// one lifecycle handle. close() is single-flight and idempotent: concurrent
// callers share one promise, and a second call after completion returns the
// same resolved promise.

import type { Express } from 'express'
import { app as expressApp, startLocalServer, stopLocalServer } from './localServer.js'
import type { YggHostCapabilities } from './hostCapabilities.js'
import { assertHeadlessPromptsAvailable } from './headlessServer/services/headlessSystemPrompt.js'
import type { YggServerConfig } from './serverConfig.js'
import { configureServerHost, resetServerHost } from './serverHost.js'

export interface YggServerHandle {
  app: Express
  port: number
  bindHost: string
  origin: string
  dbPath: string
  readonly ready: boolean
  close(): Promise<void>
}

export async function createYggServer(
  config: YggServerConfig,
  capabilities: YggHostCapabilities
): Promise<YggServerHandle> {
  configureServerHost(config, capabilities)

  try {
    // Fail at startup — not at first chat request — when the operation-mode
    // prompt assets cannot be resolved on this host.
    assertHeadlessPromptsAvailable()

    const result = await startLocalServer({
      preferredPort: config.preferredPort,
      fallbackPorts: config.fallbackPorts,
      host: config.bindHost,
      allowEphemeralPort: config.allowEphemeralPort,
      dbPath: config.dbPath,
    })

    let ready = true
    let closePromise: Promise<void> | null = null

    return {
      app: expressApp,
      port: result.port,
      bindHost: result.host,
      origin: config.advertisedOrigin ?? result.url,
      dbPath: result.dbPath,
      get ready() {
        return ready
      },
      close() {
        if (!closePromise) {
          ready = false
          closePromise = stopLocalServer().finally(() => {
            resetServerHost()
          })
        }
        return closePromise
      },
    }
  } catch (error) {
    resetServerHost()
    throw error
  }
}
