import path from 'path'
import { pathToFileURL } from 'url'
import { LspSession } from './LspSession.js'
import {
  buildUnavailableLspResolveResult,
  getLspLanguageForFilePath,
  getLspServerDefinition,
  listLspServers,
  resolveLspCommand,
} from './LspServerRegistry.js'
import { findWorkspaceRoot } from './WorkspaceResolver.js'
import { collectLspFileContext } from './LspToolContext.js'
import type {
  LspFileContext,
  LspResolveResult,
  LspServerSummary,
  LspSessionAttachOptions,
  LspSessionSummary,
  LspServerDefinition,
  ResolvedLspCommand,
} from './types.js'

function normalizeWorkspacePath(workspacePath: string): string {
  const resolvedPath = path.resolve(workspacePath)
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

export function createLspSessionKey(serverId: string, workspacePath: string): string {
  return `${serverId}::${normalizeWorkspacePath(workspacePath)}`
}

function buildWorkspaceUri(workspacePath: string): string {
  return pathToFileURL(path.resolve(workspacePath)).toString()
}

export class LspManager {
  private readonly sessions = new Map<string, LspSession>()

  listServers(): LspServerSummary[] {
    return listLspServers()
  }

  listSessions(): LspSessionSummary[] {
    return Array.from(this.sessions.values()).map(session => session.getSummary())
  }

  resolveFile(filePath: string, preferredServerId?: string | null): LspResolveResult {
    const resolvedFilePath = path.resolve(filePath)
    const languageMatch = getLspLanguageForFilePath(resolvedFilePath)

    if (!languageMatch) {
      return buildUnavailableLspResolveResult(
        resolvedFilePath,
        'No configured LSP server matches this file extension.',
        null,
        null
      )
    }

    const selectedServerId = preferredServerId?.trim() || languageMatch.serverId
    const serverDefinition = getLspServerDefinition(selectedServerId)

    if (!serverDefinition) {
      return buildUnavailableLspResolveResult(
        resolvedFilePath,
        `LSP server '${selectedServerId}' is not registered.`,
        languageMatch.lspLanguageId,
        selectedServerId
      )
    }

    const workspacePath = findWorkspaceRoot(resolvedFilePath, serverDefinition.rootMarkers)
    const workspaceUri = buildWorkspaceUri(workspacePath)
    const sessionKey = createLspSessionKey(serverDefinition.id, workspacePath)
    const resolvedCommand = resolveLspCommand(serverDefinition)

    if (!resolvedCommand) {
      return {
        available: false,
        filePath: resolvedFilePath,
        fileUri: pathToFileURL(resolvedFilePath).toString(),
        lspLanguageId: languageMatch.lspLanguageId,
        serverId: serverDefinition.id,
        sessionKey,
        workspacePath,
        workspaceUri,
        command: null,
        commandSource: null,
        args: [],
        initializationOptions: serverDefinition.initializationOptions,
        settings: serverDefinition.settings,
        reason: `No executable for '${serverDefinition.id}' was found at a configured path, in the global npm bin directory, or on PATH.`,
      }
    }

    return {
      available: true,
      filePath: resolvedFilePath,
      fileUri: pathToFileURL(resolvedFilePath).toString(),
      lspLanguageId: languageMatch.lspLanguageId,
      serverId: serverDefinition.id,
      sessionKey,
      workspacePath,
      workspaceUri,
      command: resolvedCommand.command,
      commandSource: resolvedCommand.source,
      args: [...resolvedCommand.args],
      initializationOptions: serverDefinition.initializationOptions,
      settings: serverDefinition.settings,
      reason: null,
    }
  }

  private buildSession(serverDefinition: LspServerDefinition, workspacePath: string, resolvedCommand: ResolvedLspCommand): LspSession {
    const sessionKey = createLspSessionKey(serverDefinition.id, workspacePath)
    return new LspSession({
      sessionKey,
      serverDefinition,
      workspacePath,
      workspaceUri: buildWorkspaceUri(workspacePath),
      resolvedCommand,
    })
  }

  ensureSession(serverId: string, workspacePath: string): LspSession {
    const serverDefinition = getLspServerDefinition(serverId)
    if (!serverDefinition) {
      throw new Error(`Unknown LSP server '${serverId}'.`)
    }

    const resolvedWorkspacePath = path.resolve(workspacePath)
    const sessionKey = createLspSessionKey(serverId, resolvedWorkspacePath)
    const existingSession = this.sessions.get(sessionKey)
    if (existingSession) {
      return existingSession
    }

    const resolvedCommand = resolveLspCommand(serverDefinition)
    if (!resolvedCommand) {
      throw new Error(
        `No executable for '${serverId}' was found for workspace '${resolvedWorkspacePath}'. Install the server globally, add it to PATH, or configure an absolute executable path for ${serverId}.`
      )
    }

    const session = this.buildSession(serverDefinition, resolvedWorkspacePath, resolvedCommand)
    this.sessions.set(sessionKey, session)
    return session
  }

  async attachSocket(options: LspSessionAttachOptions): Promise<void> {
    const session = this.ensureSession(options.serverId, options.workspacePath)
    await session.attachSocket(options)
  }

  async collectFileContext(filePath: string, preferredServerId?: string | null): Promise<LspFileContext | null> {
    const resolved = this.resolveFile(filePath, preferredServerId)
    return collectLspFileContext(resolved)
  }

  async restartSession(serverId: string, workspacePath: string): Promise<LspSessionSummary> {
    const session = this.ensureSession(serverId, workspacePath)
    await session.restart()
    return session.getSummary()
  }

  async shutdownSession(serverId: string, workspacePath: string): Promise<boolean> {
    const sessionKey = createLspSessionKey(serverId, workspacePath)
    const session = this.sessions.get(sessionKey)
    if (!session) return false
    await session.stop(true)
    this.sessions.delete(sessionKey)
    return true
  }

  async shutdownServer(serverId: string): Promise<number> {
    const matchingSessions = Array.from(this.sessions.values()).filter(session => session.serverDefinition.id === serverId)
    if (matchingSessions.length === 0) return 0

    for (const session of matchingSessions) {
      this.sessions.delete(session.sessionKey)
    }

    await Promise.allSettled(matchingSessions.map(session => session.stop(true)))
    return matchingSessions.length
  }

  async shutdown(): Promise<void> {
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    await Promise.allSettled(sessions.map(session => session.stop(true)))
  }
}

export const lspManager = new LspManager()
