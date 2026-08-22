import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { getConfiguredLspCommand } from './LspSettingsStore.js'
import type { LspResolveResult, LspServerDefinition, LspServerSummary, ResolvedLspCommand } from './types.js'

const isWindows = process.platform === 'win32'

const serverDefinitions: LspServerDefinition[] = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    transport: 'stdio',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    commandCandidates: ['vtsls', 'typescript-language-server'],
    args: ['--stdio'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
  },
  {
    id: 'json',
    label: 'JSON',
    transport: 'stdio',
    languages: ['json'],
    commandCandidates: ['vscode-json-language-server'],
    args: ['--stdio'],
    rootMarkers: ['package.json', '.git'],
  },
  {
    id: 'yaml',
    label: 'YAML',
    transport: 'stdio',
    languages: ['yaml'],
    commandCandidates: ['yaml-language-server'],
    args: ['--stdio'],
    rootMarkers: ['package.json', '.git'],
  },
]

const extensionLanguageMap: Record<string, { lspLanguageId: string; serverId: string }> = {
  js: { lspLanguageId: 'javascript', serverId: 'typescript' },
  mjs: { lspLanguageId: 'javascript', serverId: 'typescript' },
  cjs: { lspLanguageId: 'javascript', serverId: 'typescript' },
  jsx: { lspLanguageId: 'javascriptreact', serverId: 'typescript' },
  ts: { lspLanguageId: 'typescript', serverId: 'typescript' },
  tsx: { lspLanguageId: 'typescriptreact', serverId: 'typescript' },
  json: { lspLanguageId: 'json', serverId: 'json' },
  yml: { lspLanguageId: 'yaml', serverId: 'yaml' },
  yaml: { lspLanguageId: 'yaml', serverId: 'yaml' },
}

function getEnvOverrideKey(serverId: string): string {
  return `YGG_LSP_${serverId.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_COMMAND`
}

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim()
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(trimValue).filter(Boolean)))
}

function getExecutableCandidates(command: string): string[] {
  if (!isWindows) return [command]

  const parsed = path.parse(command)
  if (parsed.ext) return [command]
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
}

function resolveExistingExecutablePath(commandPath: string): string | null {
  for (const candidate of getExecutableCandidates(commandPath)) {
    if (!fs.existsSync(candidate)) continue
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      return candidate
    }
  }

  return null
}

function findExecutableInDirectory(directoryPath: string, command: string): string | null {
  for (const candidate of getExecutableCandidates(command)) {
    const executable = resolveExistingExecutablePath(path.join(directoryPath, candidate))
    if (executable) {
      return executable
    }
  }

  return null
}

function findExecutableOnPath(command: string): string | null {
  const normalized = trimValue(command)
  if (!normalized) return null

  if (path.isAbsolute(normalized)) {
    return resolveExistingExecutablePath(normalized)
  }

  if (normalized.includes(path.sep) || (path.posix.sep !== path.sep && normalized.includes(path.posix.sep))) {
    return resolveExistingExecutablePath(path.resolve(normalized))
  }

  const finder = isWindows ? 'where' : 'which'
  const result = spawnSync(finder, [normalized], {
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.status !== 0) return null
  const firstLine = trimValue(result.stdout.split(/\r?\n/).find(Boolean))
  return firstLine || null
}

function getGlobalNpmBinDirectories(): string[] {
  const npmPrefix = trimValue(process.env.npm_config_prefix || process.env.PREFIX)

  if (isWindows) {
    const appData = trimValue(process.env.APPDATA)
    return uniqueStrings([npmPrefix, appData ? path.join(appData, 'npm') : null])
  }

  const home = trimValue(process.env.HOME)
  return uniqueStrings([
    npmPrefix ? path.join(npmPrefix, 'bin') : null,
    home ? path.join(home, '.npm-global', 'bin') : null,
  ])
}

function resolveConfiguredCommand(serverDefinition: LspServerDefinition): ResolvedLspCommand | null {
  const configuredCommand = trimValue(getConfiguredLspCommand(serverDefinition.id))
  if (!configuredCommand || !path.isAbsolute(configuredCommand)) {
    return null
  }

  const resolvedCommand = findExecutableOnPath(configuredCommand)
  if (!resolvedCommand) {
    return null
  }

  return {
    command: resolvedCommand,
    args: [...serverDefinition.args],
    source: 'configured',
  }
}

function resolveCommandFromCandidates(serverDefinition: LspServerDefinition): ResolvedLspCommand | null {
  const configuredCommand = resolveConfiguredCommand(serverDefinition)
  if (configuredCommand) {
    return configuredCommand
  }

  const envOverride = trimValue(process.env[getEnvOverrideKey(serverDefinition.id)])
  if (envOverride) {
    const resolvedEnvCommand = findExecutableOnPath(envOverride) || envOverride
    return {
      command: resolvedEnvCommand,
      args: [...serverDefinition.args],
      source: 'env',
    }
  }

  const globalNpmBinDirectories = getGlobalNpmBinDirectories()

  for (const commandCandidate of serverDefinition.commandCandidates) {
    for (const directoryPath of globalNpmBinDirectories) {
      const executable = findExecutableInDirectory(directoryPath, commandCandidate)
      if (!executable) continue
      return {
        command: executable,
        args: [...serverDefinition.args],
        source: 'global-npm',
      }
    }

    const pathExecutable = findExecutableOnPath(commandCandidate)
    if (pathExecutable) {
      return {
        command: pathExecutable,
        args: [...serverDefinition.args],
        source: 'path',
      }
    }
  }

  return null
}

export function getLspServerDefinitions(): LspServerDefinition[] {
  return serverDefinitions.map(definition => ({
    ...definition,
    languages: [...definition.languages],
    commandCandidates: [...definition.commandCandidates],
    args: [...definition.args],
    rootMarkers: [...definition.rootMarkers],
    env: definition.env ? { ...definition.env } : undefined,
  }))
}

export function getLspServerDefinition(serverId: string): LspServerDefinition | null {
  return serverDefinitions.find(definition => definition.id === serverId) || null
}

export function getLspLanguageForFilePath(filePath: string): { lspLanguageId: string; serverId: string } | null {
  const extension = trimValue(path.extname(filePath)).replace(/^\./, '').toLowerCase()
  if (!extension) return null
  return extensionLanguageMap[extension] || null
}

export function resolveLspCommand(serverDefinition: LspServerDefinition): ResolvedLspCommand | null {
  return resolveCommandFromCandidates(serverDefinition)
}

export function listLspServers(): LspServerSummary[] {
  return getLspServerDefinitions().map(definition => {
    const resolvedCommand = resolveLspCommand(definition)
    return {
      id: definition.id,
      label: definition.label,
      languages: [...definition.languages],
      rootMarkers: [...definition.rootMarkers],
      preferredCommand: resolvedCommand?.command || null,
      commandSource: resolvedCommand?.source || null,
      available: Boolean(resolvedCommand),
      reason: resolvedCommand ? null : 'No matching executable was found at a configured path, in the global npm bin directory, or on PATH.',
    }
  })
}

export function buildUnavailableLspResolveResult(filePath: string, reason: string, lspLanguageId: string | null = null, serverId: string | null = null): LspResolveResult {
  return {
    available: false,
    filePath,
    fileUri: pathToFileURL(path.resolve(filePath)).toString(),
    lspLanguageId,
    serverId,
    sessionKey: null,
    workspacePath: null,
    workspaceUri: null,
    command: null,
    commandSource: null,
    args: [],
    reason,
  }
}
