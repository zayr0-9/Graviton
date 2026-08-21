// electron/server/serverHost.ts
// Process-wide host context for the server graph.
//
// createYggServer() installs the active config and capabilities here before it
// initializes any resource. Deep modules (tools/todoMd.ts, skills/skillLoader.ts,
// mcp/mcpManager.ts, headlessServer config/providers) read paths and
// capabilities through these accessors instead of importing `electron`.
//
// The strict accessors throw when the host is not configured — a module that
// needs a path before startup wiring ran is a defect, not a case to paper
// over. The try* accessors exist for modules that keep a legacy fallback
// (e.g. a cwd-relative directory in unit tests).

import type { YggHostCapabilities } from './hostCapabilities.js'
import type { YggServerConfig } from './serverConfig.js'

let activeConfig: YggServerConfig | null = null
let activeCapabilities: YggHostCapabilities | null = null
let hostGatedToolNames: ReadonlySet<string> = new Set()

export function configureServerHost(config: YggServerConfig, capabilities: YggHostCapabilities): void {
  activeConfig = config
  activeCapabilities = capabilities
}

export function resetServerHost(): void {
  activeConfig = null
  activeCapabilities = null
  hostGatedToolNames = new Set()
}

/**
 * Built-in tool names the current host cannot run (e.g. `browse_web` without
 * a BrowserEngine). Set by the tool registry during startup. Advertised tool
 * lists filter through isBuiltInToolAvailable so the model is never offered a
 * gated tool. An unconfigured host gates nothing, which preserves legacy
 * behavior for unit tests that never start a server.
 */
export function setHostGatedToolNames(names: ReadonlySet<string>): void {
  hostGatedToolNames = names
}

export function isBuiltInToolAvailable(toolName: string): boolean {
  return !hostGatedToolNames.has(toolName)
}

export function isServerHostConfigured(): boolean {
  return activeConfig !== null && activeCapabilities !== null
}

export function tryGetServerConfig(): YggServerConfig | null {
  return activeConfig
}

export function tryGetHostCapabilities(): YggHostCapabilities | null {
  return activeCapabilities
}

export function getServerConfig(): YggServerConfig {
  if (!activeConfig) {
    throw new Error(
      '[ServerHost] Server host is not configured. createYggServer() must run before this module is used.'
    )
  }
  return activeConfig
}

export function getHostCapabilities(): YggHostCapabilities {
  if (!activeCapabilities) {
    throw new Error(
      '[ServerHost] Host capabilities are not configured. createYggServer() must run before this module is used.'
    )
  }
  return activeCapabilities
}

export function getServerDataDir(): string {
  return getServerConfig().dataDir
}

export function getServerTempDir(): string {
  return getServerConfig().tempDir
}

export function getServerResourcesDir(): string {
  return getServerConfig().resourcesDir
}
