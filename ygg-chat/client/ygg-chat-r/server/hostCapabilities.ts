// server/server/hostCapabilities.ts
// Host capability contracts for the runtime-neutral server graph.
//
// The server factory receives one YggHostCapabilities object. The Electron
// adapter backs these with `electron.app`, `Conf`, and `utilityProcess`; the
// standalone CLI backs them with plain Node equivalents. No module in the
// server graph may import `electron` — anything Electron-specific arrives
// through this interface instead.

import type { ToolExecutionOptions } from './tools/runtime/protocol.js'

/**
 * Key/value settings store. The Electron adapter wraps `Conf` with
 * projectName 'ygg-chat-r' so existing stored key formats (`auth_session`,
 * `gateway.*`, `openai_chatgpt_tokens`) keep working. Keys may be dotted
 * paths into nested objects, matching Conf semantics.
 */
export interface KeyValueStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** Secret storage. Implementations must not log values. */
export interface SecretStore {
  getSecret(key: string): Promise<string | null>
  setSecret(key: string, value: string): Promise<void>
  deleteSecret(key: string): Promise<void>
}

/**
 * Out-of-process tool sandbox. Runs the whitelisted built-in tools and every
 * custom tool outside the server process. Electron forks toolRuntimeUtility.mjs
 * via `utilityProcess`; standalone forks the same bundle via `child_process`.
 * The message protocol (tools/runtime/protocol.ts) is identical on both hosts.
 */
export interface ToolSandboxHost {
  initialize(): Promise<void>
  executeTool(toolName: string, args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<any>
  reloadCustomTools(reason?: string): Promise<{ success: boolean; totalCount?: number; durationMs?: number }>
  shutdown(): Promise<void>
}

/**
 * Web-page driver for the `browse_web` tool. Electron supplies one backed by
 * BrowserWindow. Standalone supplies none until a headless engine lands
 * (follow-on F1); when absent, the tool registry omits `browse_web` so the
 * model is never offered a tool the host cannot run.
 */
export interface BrowserEngine {
  browse(url: string, options: Record<string, unknown>): Promise<unknown>
}

export interface YggHostCapabilities {
  /** Relaunch the host process. Absent on standalone: /api/app/restart returns 501. */
  restart?: () => Promise<void>
  /** Open a URL in the user's browser (MCP interactive OAuth). */
  openExternal?: (url: string) => Promise<void>
  configStore: KeyValueStore
  secretStore: SecretStore
  /**
   * Required when config.toolRuntime.mode is 'utility'. `null` only makes
   * sense with mode 'local' (every tool runs in-process).
   */
  toolSandbox: ToolSandboxHost | null
  browserEngine?: BrowserEngine
}
