// electron/localServer.ts
// Embedded local SQLite server for dual-sync in Electron mode
// This server prefers port 3002 and falls back to available local ports.

import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import cors from 'cors'
import crypto from 'crypto'
import { app as electronApp } from 'electron'
import express from 'express'
import fs from 'fs'
import { createRequire as createNodeRequire } from 'module'
import type { AddressInfo } from 'net'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { WebSocket, WebSocketServer } from 'ws'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions.js'
import { isManagedToolPath } from './utils/managedToolPaths.js'

// Tool imports
import { registerHeadlessServerRoutes } from './headlessServer/index.js'
import { embedText as embedTextWithLmStudio, embedTexts as embedTextsWithLmStudio, getLmStudioBaseUrl } from './headlessServer/providers/lmStudioEmbeddings.js'
import {
  handleLspWebSocketUpgrade,
  initializeLspLocalServer,
  registerLspRoutes,
  shutdownLspLocalServer,
} from './lsp/localServerIntegration.js'
import { listManagedHooks, setManagedHookEnabled } from './hooks/hookManager.js'
import { runHookRequest } from './hooks/hookRunner.js'
import { registerLocalOperationsRoutes } from './localOperations.js'
import { createToolsStatements, initializeToolsSchema, pruneOldTools, registerToolsRoutes } from './localToolsRoutes.js'
import { mcpManager } from './mcp/mcpManager.js'
import { registerMcpRoutes } from './mcp/mcpRoutes.js'
import { registerProxyRoutes } from './proxyGateway.js'
import { skillRegistry } from './skills/skillLoader.js'
import { execute as executeSkillManager } from './skills/skillManager.js'
import { registerSkillRoutes } from './skills/skillRoutes.js'
import { runBashCommand } from './tools/bash.js'
import { runPowerShellCommand } from './tools/powershell.js'
import { braveSearch } from './tools/braveSearch.js'
import { browseWeb } from './tools/browseWeb.js'
import { CCResponse, executeClaudeCode, getAvailableSlashCommands, getSession, setSession } from './tools/claudeCode.js'
import { createTextFile } from './tools/createFile.js'
import { customToolRegistry, type CustomToolsChangedEvent, ToolResult } from './tools/customToolLoader.js'
import { execute as executeCustomToolManager } from './tools/customToolManager.js'
import { deleteFile, safeDeleteFile } from './tools/deleteFile.js'
import { extractDirectoryStructure } from './tools/directory.js'
import { editFile, multiEdit } from './tools/editFile.js'
import { execute as executeFetchChats, executeFetchNotes } from './tools/fetchChats.js'
import { execute as executeInternalLink } from './tools/internalLink.js'
import { globSearch } from './tools/glob.js'
import { executeHermesAgent, getHermesSession, setHermesSession } from './tools/hermesAgent.js'
import { resolveHermesExecutionPlan } from './tools/hermesExecutionPlanner.js'
import htmlRenderer from './tools/htmlRenderer.js'
import { execute as executeMcpManagerTool } from './tools/mcpManagerTool.js'
import { JobFilter, JobOptions, toolOrchestrator } from './tools/orchestrator/index.js'
import { readFileContinuation, readTextFile } from './tools/readFile.js'
import { readMultipleTextFiles } from './tools/readFiles.js'
import { ripgrepSearch } from './tools/ripgrep.js'
import { viewImage } from './tools/viewImage.js'
import { UtilityToolRuntimeHost } from './tools/runtime/UtilityToolRuntimeHost.js'
import { execute as executeThemeManager } from './tools/themeManager.js'
import { createTodoList, editTodoList, listTodoLists, readTodoList } from './tools/todoMd.js'

/**
 * Validates and resolves a path to ensure it's within the allowed rootPath scope.
 * Prevents directory traversal attacks.
 */
function validateAndResolvePath(
  inputPath: string | undefined,
  rootPath: string | undefined,
  fallbackToRoot = true
): string {
  const normalizedInput = typeof inputPath === 'string' ? inputPath.trim() : ''

  // If no input path provided
  if (!normalizedInput) {
    if (fallbackToRoot && rootPath) return rootPath
    return '.'
  }

  // Detect if we should use POSIX logic (WSL paths on Windows)
  // If on Windows, but paths start with '/', treat as WSL/Linux path
  const usePosix =
    process.platform === 'win32' && ((inputPath && inputPath.startsWith('/')) || (rootPath && rootPath.startsWith('/')))

  const pathModule = usePosix ? path.posix : path

  // If no rootPath constraint, just resolve the path
  if (!rootPath) {
    return pathModule.resolve(normalizedInput)
  }

  const normalizedRoot = pathModule.resolve(rootPath)

  // Resolve to absolute path
  const resolvedPath = pathModule.isAbsolute(normalizedInput)
    ? pathModule.resolve(normalizedInput)
    : pathModule.resolve(normalizedRoot, normalizedInput)

  // Security: Ensure resolved path is within rootPath scope
  const relativeToRoot = pathModule.relative(normalizedRoot, resolvedPath)
  const outsideWorkspace =
    relativeToRoot === '..' || relativeToRoot.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relativeToRoot)

  if (outsideWorkspace) {
    const rootIsManagedPath = isManagedToolPath(normalizedRoot, usePosix)
    const targetIsManagedPath = isManagedToolPath(resolvedPath, usePosix)
    if (!rootIsManagedPath && targetIsManagedPath) {
      return resolvedPath
    }
    throw new Error(`Path must be within workspace: ${rootPath}`)
  }

  return resolvedPath
}

function resolveToolWorkspaceCwd(requestedCwd: unknown, rootPath: string | undefined): string | undefined {
  const normalizedRequested = typeof requestedCwd === 'string' ? requestedCwd.trim() : ''
  if (!normalizedRequested) {
    return rootPath || undefined
  }
  return validateAndResolvePath(normalizedRequested, rootPath)
}

function sanitizeZipEntryName(entryName: string): string {
  return entryName.replace(/\\/g, '/').replace(/^\/+/, '')
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.bat', '.sh'])
const MAX_UPLOAD_ENTRIES = 5000
const MAX_UPLOAD_UNPACKED_BYTES = 500 * 1024 * 1024
const REMOTE_API_BASE = 'https://webdrasil-production.up.railway.app/api'
const DEFAULT_PRESERVE_RESOURCE_DIRS = ['resources', 'resource']
const HERMES_PERMISSION_RESPONSE_TIMEOUT_MS = 55_000

type HermesPermissionDecision = 'allow_once' | 'allow_always' | 'deny'

type PendingHermesPermissionRequest = {
  conversationId: string
  createdAt: number
  resolve: (decision: HermesPermissionDecision) => void
}

const pendingHermesPermissionRequests = new Map<string, PendingHermesPermissionRequest>()

function normalizeHermesPermissionToolCall(rawRequest: any): { id: string; name: string; arguments: Record<string, any> } {
  const rawToolCall =
    rawRequest?.toolCall && typeof rawRequest.toolCall === 'object'
      ? rawRequest.toolCall
      : rawRequest?.tool_call && typeof rawRequest.tool_call === 'object'
        ? rawRequest.tool_call
        : {}

  const toolCallId =
    typeof rawToolCall.id === 'string' && rawToolCall.id.trim().length > 0
      ? rawToolCall.id
      : typeof rawToolCall.toolCallId === 'string' && rawToolCall.toolCallId.trim().length > 0
        ? rawToolCall.toolCallId
        : typeof rawToolCall.tool_call_id === 'string' && rawToolCall.tool_call_id.trim().length > 0
          ? rawToolCall.tool_call_id
          : uuidv4()

  const toolName =
    typeof rawToolCall.title === 'string' && rawToolCall.title.trim().length > 0
      ? rawToolCall.title
      : typeof rawToolCall.name === 'string' && rawToolCall.name.trim().length > 0
        ? rawToolCall.name
        : typeof rawToolCall.kind === 'string' && rawToolCall.kind.trim().length > 0
          ? rawToolCall.kind
          : 'hermes_permission'

  const toolArgs: Record<string, any> =
    rawToolCall.rawInput && typeof rawToolCall.rawInput === 'object'
      ? rawToolCall.rawInput
      : rawToolCall.raw_input && typeof rawToolCall.raw_input === 'object'
        ? rawToolCall.raw_input
        : {}

  if (typeof rawRequest?.description === 'string' && !('description' in toolArgs)) {
    toolArgs.description = rawRequest.description
  }

  return {
    id: toolCallId,
    name: toolName,
    arguments: toolArgs,
  }
}

function buildRemoteApiUrl(pathname: string): string {
  if (pathname.startsWith('/')) {
    return `${REMOTE_API_BASE}${pathname}`
  }
  return `${REMOTE_API_BASE}/${pathname}`
}

function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}

function validateToolDefinition(definition: any): string | null {
  if (!definition || typeof definition !== 'object') return 'definition.json must be an object.'
  if (typeof definition.name !== 'string' || !isValidToolName(definition.name)) {
    return 'definition.json must include a valid "name" (lowercase letters, numbers, underscores).'
  }
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    return 'definition.json must include a non-empty "description".'
  }
  if (!definition.inputSchema || typeof definition.inputSchema !== 'object') {
    return 'definition.json must include an "inputSchema" object.'
  }
  if (definition.inputSchema.type !== 'object') {
    return 'definition.json "inputSchema.type" must be "object".'
  }
  if (!definition.inputSchema.properties || typeof definition.inputSchema.properties !== 'object') {
    return 'definition.json "inputSchema.properties" must be an object.'
  }
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
    return 'definition.json "enabled" must be a boolean if provided.'
  }
  return null
}

function validateDescription(description: any): string | null {
  if (!description || typeof description !== 'object') return 'description.json must be an object.'
  const title = typeof description.title === 'string' ? description.title.trim() : ''
  const name = typeof description.name === 'string' ? description.name.trim() : ''
  if (!title && !name) {
    return 'description.json must include a "title" or "name".'
  }
  if (description.gitLink !== undefined) {
    if (typeof description.gitLink !== 'string' || !description.gitLink.trim()) {
      return 'description.json "gitLink" must be a non-empty string when provided.'
    }
    try {
      const url = new URL(description.gitLink)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'description.json "gitLink" must be an http(s) URL.'
      }
    } catch {
      return 'description.json "gitLink" must be a valid URL.'
    }
  }
  return null
}

function detectZipStripPrefix(entries: { entryName: string }[]): string | null {
  const normalized = entries.map(entry => sanitizeZipEntryName(entry.entryName)).filter(Boolean)
  if (normalized.length === 0) return null
  const prefix = 'custom-tools/'
  if (normalized.every(name => name.startsWith(prefix))) {
    return prefix
  }
  return null
}

async function extractZipBufferToDirectory(
  zipBuffer: Buffer,
  destDir: string
): Promise<{ extracted: number; skipped: number; strippedPrefix?: string | null }> {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  const stripPrefix = detectZipStripPrefix(entries)
  const rootDir = path.resolve(destDir)
  let extracted = 0
  let skipped = 0

  for (const entry of entries) {
    let entryName = sanitizeZipEntryName(entry.entryName)
    if (stripPrefix && entryName.startsWith(stripPrefix)) {
      entryName = entryName.slice(stripPrefix.length)
    }
    if (!entryName || entryName === '.' || entryName === '..') {
      continue
    }

    const targetPath = path.resolve(rootDir, entryName)
    if (!targetPath.startsWith(rootDir + path.sep) && targetPath !== rootDir) {
      skipped += 1
      continue
    }

    if (entry.isDirectory) {
      await fs.promises.mkdir(targetPath, { recursive: true })
      continue
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.promises.writeFile(targetPath, entry.getData())
    extracted += 1
  }

  return { extracted, skipped, strippedPrefix: stripPrefix }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath)
    return true
  } catch {
    return false
  }
}

function detectZipToolDirectoryName(entries: { entryName: string }[], strippedPrefix?: string | null): string | null {
  const rootDirs = new Set<string>()

  for (const entry of entries) {
    let entryName = sanitizeZipEntryName(entry.entryName)
    if (strippedPrefix && entryName.startsWith(strippedPrefix)) {
      entryName = entryName.slice(strippedPrefix.length)
    }

    if (!entryName) continue

    const [root] = entryName.split('/')
    if (!root || root === '.' || root === '..' || root === '__MACOSX') {
      continue
    }

    rootDirs.add(root)
  }

  if (rootDirs.size !== 1) {
    return null
  }

  return Array.from(rootDirs)[0]
}

async function stageZipBufferForToolInstall(zipBuffer: Buffer): Promise<{
  tempDir: string
  stagedToolsRoot: string
  stagedToolDirName: string
  stagedToolPath: string
  extracted: number
  skipped: number
  strippedPrefix?: string | null
}> {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  const strippedPrefix = detectZipStripPrefix(entries)
  const stagedToolDirName = detectZipToolDirectoryName(entries, strippedPrefix)

  if (!stagedToolDirName) {
    throw new Error('Zip must contain exactly one top-level tool directory.')
  }

  const tempDir = await fs.promises.mkdtemp(path.join(electronApp.getPath('temp'), 'ygg-app-store-'))
  const stagedToolsRoot = path.join(tempDir, 'custom-tools')
  await fs.promises.mkdir(stagedToolsRoot, { recursive: true })

  const { extracted, skipped } = await extractZipBufferToDirectory(zipBuffer, stagedToolsRoot)
  const stagedToolPath = path.join(stagedToolsRoot, stagedToolDirName)

  const stagedExists = await pathExists(stagedToolPath)
  if (!stagedExists) {
    throw new Error('Installed package is missing the expected tool directory.')
  }

  return {
    tempDir,
    stagedToolsRoot,
    stagedToolDirName,
    stagedToolPath,
    extracted,
    skipped,
    strippedPrefix,
  }
}

async function deployToolUpdateWithPreservedResources(options: {
  stagedToolPath: string
  targetToolPath: string
  preserveDirs?: string[]
}): Promise<{ preservedResources: number }> {
  const preserveDirs = (options.preserveDirs || DEFAULT_PRESERVE_RESOURCE_DIRS).filter(Boolean)
  const targetParentDir = path.dirname(options.targetToolPath)
  const targetName = path.basename(options.targetToolPath)
  const rollbackPath = path.join(
    targetParentDir,
    `${targetName}.__rollback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  )

  await fs.promises.rename(options.targetToolPath, rollbackPath)

  try {
    await fs.promises.cp(options.stagedToolPath, options.targetToolPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    })

    let preservedResources = 0

    for (const dirName of preserveDirs) {
      const sourcePath = path.join(rollbackPath, dirName)
      if (!(await pathExists(sourcePath))) {
        continue
      }

      const restorePath = path.join(options.targetToolPath, dirName)
      await fs.promises.rm(restorePath, { recursive: true, force: true })
      await fs.promises.cp(sourcePath, restorePath, {
        recursive: true,
        force: true,
        errorOnExist: false,
      })
      preservedResources += 1
    }

    await fs.promises.rm(rollbackPath, { recursive: true, force: true })
    return { preservedResources }
  } catch (error) {
    await fs.promises.rm(options.targetToolPath, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rename(rollbackPath, options.targetToolPath).catch(() => undefined)
    throw error
  }
}

// Built-in tool handler type
type BuiltInToolHandler = (
  args: any,
  options: {
    rootPath?: string
    operationMode?: 'plan' | 'execute'
    conversationId?: string | null
    messageId?: string | null
    streamId?: string | null
  }
) => Promise<ToolResult>

// Registry for built-in tools (initialized in setupServer)
const builtInTools: Map<string, BuiltInToolHandler> = new Map()
const utilityToolRuntimeHost = new UtilityToolRuntimeHost()
let utilityRuntimeAvailable = false

function getToolRuntimeMode(): 'local' | 'utility' {
  return process.env.YGG_TOOLS_RUNTIME?.trim().toLowerCase() === 'utility' ? 'utility' : 'local'
}

function isUtilityRuntimeFallbackDisabled(): boolean {
  const rawValue = process.env.DISABLE_TOOL_RUNTIME_FALLBACK?.trim().toLowerCase()
  if (!rawValue) return false
  return rawValue === '1' || rawValue === 'true' || rawValue === 'yes' || rawValue === 'on'
}

const UTILITY_RUNTIME_TOOL_WHITELIST = new Set<string>([
  'read_file',
  'read_file_continuation',
  'read_files',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'directory',
  'view_image',
  'glob',
  'ripgrep',
  'bash',
  'powershell',
  'html_renderer',
])

function shouldUseUtilityRuntimeForTool(toolName: string): boolean {
  return UTILITY_RUNTIME_TOOL_WHITELIST.has(toolName)
}

function shouldUseUtilityRuntimeForCustomTool(toolName: string): boolean {
  if (getToolRuntimeMode() !== 'utility') return false
  if (!utilityRuntimeAvailable) return false
  if (!customToolRegistry.hasCustomTool(toolName)) return false
  return true
}

// Initialize built-in tools registry
function initializeBuiltInToolRegistry() {
  builtInTools.set('html_renderer', async args => {
    const { html, allowUnsafe } = args
    if (!html) throw new Error('html is required')
    const rendered = await htmlRenderer.run({ html, allowUnsafe })
    return rendered
  })

  builtInTools.set('read_file', async (args, { rootPath }) => {
    const { path: filePath, maxBytes, startLine, endLine, ranges, includeHash, cwd } = args
    if (!filePath) throw new Error('path is required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    const fileRes = await readTextFile(filePath, {
      maxBytes,
      startLine,
      endLine,
      ranges,
      includeHash,
      cwd: effectiveCwd,
    })
    return { success: true, ...fileRes }
  })

  builtInTools.set('read_file_continuation', async (args, { rootPath }) => {
    const { path: filePath, afterLine, numLines, maxBytes, includeHash, cwd } = args
    if (!filePath) throw new Error('path is required')
    if (afterLine === undefined) throw new Error('afterLine is required')
    if (!numLines) throw new Error('numLines is required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    const fileRes = await readFileContinuation(filePath, afterLine, numLines, {
      maxBytes,
      includeHash,
      cwd: effectiveCwd,
    })
    return { success: true, ...fileRes }
  })

  builtInTools.set('read_files', async (args, { rootPath }) => {
    const { paths, baseDir, maxBytes, startLine, endLine, cwd } = args
    if (!paths) throw new Error('paths are required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    const filesRes = await readMultipleTextFiles(paths, { baseDir, maxBytes, startLine, endLine, cwd: effectiveCwd })
    return { success: true, files: filesRes }
  })

  builtInTools.set('create_file', async (args, { rootPath, operationMode }) => {
    const { path: filePath, content, createParentDirs, overwrite, executable, cwd } = args
    if (!filePath) throw new Error('path is required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    return await createTextFile(filePath, content, {
      createParentDirs,
      overwrite,
      executable,
      operationMode,
      cwd: effectiveCwd,
    })
  })

  builtInTools.set('edit_file', async (args, { rootPath, operationMode }) => {
    const {
      path: filePath,
      operation,
      searchPattern,
      replacement,
      content,
      createBackup,
      encoding,
      enableFuzzyMatching,
      fuzzyThreshold,
      preserveIndentation,
      validateContent,
      expectedHash,
      expectedMetadata,
      approxStartLine,
      approxEndLine,
    } = args
    if (!filePath) throw new Error('path is required')
    return await editFile(filePath, operation, {
      searchPattern,
      replacement,
      content,
      createBackup,
      encoding,
      enableFuzzyMatching,
      fuzzyThreshold,
      preserveIndentation,
      // Keep tool-call behavior deterministic and safe for code edits:
      // parse escape sequences in search patterns, but treat replacement text literally.
      interpretSearchEscapes: true,
      interpretReplacementEscapes: false,
      validateContent,
      expectedHash,
      expectedMetadata,
      approxStartLine,
      approxEndLine,
      operationMode,
      cwd: rootPath,
    })
  })

  builtInTools.set('multi_edit', async (args, { rootPath, operationMode }) => {
    const {
      edits,
      stopOnError,
      createBackup,
      encoding,
      enableFuzzyMatching,
      fuzzyThreshold,
      preserveIndentation,
      validateContent,
    } = args
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits are required')
    return await multiEdit(edits, {
      stopOnError,
      createBackup,
      encoding,
      enableFuzzyMatching,
      fuzzyThreshold,
      preserveIndentation,
      interpretSearchEscapes: true,
      interpretReplacementEscapes: false,
      validateContent,
      operationMode,
      cwd: rootPath,
    })
  })

  builtInTools.set('delete_file', async (args, { rootPath, operationMode }) => {
    const { path: filePath, allowedExtensions } = args
    if (!filePath) throw new Error('path is required')
    if (allowedExtensions) {
      await safeDeleteFile(filePath, allowedExtensions, operationMode, rootPath)
    } else {
      await deleteFile(filePath, operationMode, rootPath)
    }
    return { success: true, path: filePath }
  })

  builtInTools.set('directory', async (args, { rootPath }) => {
    const { path: dirPath, maxDepth, includeHidden, includeSizes } = args
    const finalDirPath = validateAndResolvePath(dirPath, rootPath)
    const structure = await extractDirectoryStructure(finalDirPath, {
      maxDepth,
      includeHidden,
      includeSizes,
    })
    return { success: true, structure, path: dirPath }
  })

  builtInTools.set('view_image', async (args, { rootPath }) => {
    const { path: imagePath, cwd, detail, maxBytes } = args
    if (!imagePath) throw new Error('path is required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    return await viewImage(imagePath, { cwd: effectiveCwd, detail, maxBytes })
  })

  builtInTools.set('glob', async (args, { rootPath }) => {
    const { pattern, cwd, ignore, dot, absolute } = args
    if (!pattern) throw new Error('pattern is required')
    const actualCwd = validateAndResolvePath(cwd, rootPath)
    return await globSearch(pattern, { cwd: actualCwd, ignore, dot, absolute })
  })

  builtInTools.set('ripgrep', async (args, { rootPath }) => {
    const {
      regex,
      pattern,
      path: dirPath,
      searchPath: altSearchPath,
      glob: globPattern,
      case_insensitive,
      lineNumbers,
      count,
      filesWithMatches,
      maxCount,
      hidden,
      noIgnore,
      contextLines,
    } = args
    const query = regex || pattern
    if (!query) throw new Error('pattern or regex is required')
    const finalSearchPath = validateAndResolvePath(dirPath || altSearchPath, rootPath)
    return await ripgrepSearch(query, finalSearchPath, {
      caseSensitive: !case_insensitive,
      glob: globPattern,
      lineNumbers,
      count,
      filesWithMatches,
      maxCount,
      hidden,
      noIgnore,
      contextLines,
    })
  })

  builtInTools.set('browse_web', async args => {
    const { url, ...options } = args
    if (!url) throw new Error('url is required')
    return await browseWeb(url, options)
  })

  builtInTools.set('brave_search', async args => {
    const { query, ...options } = args
    if (!query) throw new Error('query is required')
    return await braveSearch(query, options)
  })

  builtInTools.set('bash', async (args, { rootPath }) => {
    const { command, description, cwd, env, timeoutMs, maxOutputChars } = args
    if (!command) throw new Error('command is required')
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error('description is required')
    }
    const finalCwd = validateAndResolvePath(cwd, rootPath)
    return await runBashCommand(command, {
      description: description.trim(),
      cwd: finalCwd,
      env,
      timeoutMs,
      maxOutputChars,
    })
  })

  builtInTools.set('powershell', async (args, { rootPath }) => {
    const { command, description, cwd, env, timeoutMs, maxOutputChars } = args
    if (!command) throw new Error('command is required')
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error('description is required')
    }
    const finalCwd = validateAndResolvePath(cwd, rootPath)
    return await runPowerShellCommand(command, {
      description: description.trim(),
      cwd: finalCwd,
      env,
      timeoutMs,
      maxOutputChars,
    })
  })

  builtInTools.set('todo_list', async args => {
    const { action, name, content, search, replacement } = args
    switch (action) {
      case 'list': {
        const lists = await listTodoLists()
        return { success: true, lists }
      }
      case 'read': {
        if (!name) throw new Error('name is required for todo_list read')
        const data = await readTodoList(name)
        return { success: true, ...data }
      }
      case 'create': {
        if (content === undefined) throw new Error('content is required for todo_list create')
        const created = await createTodoList(content)
        return { success: true, ...created }
      }
      case 'edit': {
        if (!name) throw new Error('name is required for todo_list edit')
        if (!search) throw new Error('search is required for todo_list edit')
        if (replacement === undefined) throw new Error('replacement is required for todo_list edit')
        const edited = await editTodoList(name, search, replacement)
        return edited
      }
      default:
        throw new Error(`Unsupported todo_list action: ${action}`)
    }
  })

  builtInTools.set('theme_manager', async args => {
    return await executeThemeManager(args)
  })

  builtInTools.set('fetch_notes', async (args, options) => {
    return await executeFetchNotes(args, {
      currentConversationId: options?.conversationId ?? null,
      listConversations: () => {
        const getter = statements?.getAllConversations
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all()
      },
      getConversationById: conversationId => {
        const getter = statements?.getConversationById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(conversationId)
      },
      searchConversations: ({ userId, projectId, query, limit }) => {
        const trimmedQuery = typeof query === 'string' ? query.trim() : ''
        if (!trimmedQuery) return []
        const normalizedQuery = trimmedQuery.replace(/[\s_-]+/g, '')
        const likeQuery = `%${trimmedQuery}%`
        const normalizedLikeQuery = `%${normalizedQuery || trimmedQuery}%`
        if (projectId) {
          const getter = statements?.searchConversationsByTitleInProject
          if (!getter || typeof getter.all !== 'function') return []
          return getter.all(userId, projectId, likeQuery, normalizedLikeQuery, limit)
        }
        const getter = statements?.searchConversationsByTitle
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(userId, likeQuery, normalizedLikeQuery, limit)
      },
      searchTopLevelMessages: ({ userId, projectId, query, limit }) => {
        if (typeof searchTopLevelUserMessages !== 'function') return []
        return searchTopLevelUserMessages({ userId, projectId, query, limit })
      },
      searchNotes: ({ userId, projectId, query, limit }) => {
        return searchNotes({ userId, query, projectId, limit })
      },
      listMessagesByConversationId: conversationId => {
        const getter = statements?.getMessagesByConversationId
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(conversationId)
      },
      listTopLevelUserMessagesByConversationId: conversationId => {
        const getter = statements?.getTopLevelUserMessagesByConversationId
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(conversationId)
      },
      getMessageById: messageId => {
        const getter = statements?.getMessageById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(messageId)
      },
    })
  })

  builtInTools.set('fetch_chats', async (args, options) => {
    return await executeFetchChats(args, {
      currentConversationId: options?.conversationId ?? null,
      listConversations: () => {
        const getter = statements?.getAllConversations
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all()
      },
      getConversationById: conversationId => {
        const getter = statements?.getConversationById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(conversationId)
      },
      searchConversations: ({ userId, projectId, query, limit }) => {
        const trimmedQuery = typeof query === 'string' ? query.trim() : ''
        if (!trimmedQuery) return []
        const normalizedQuery = trimmedQuery.replace(/[\s_-]+/g, '')
        const likeQuery = `%${trimmedQuery}%`
        const normalizedLikeQuery = `%${normalizedQuery || trimmedQuery}%`
        if (projectId) {
          const getter = statements?.searchConversationsByTitleInProject
          if (!getter || typeof getter.all !== 'function') return []
          return getter.all(userId, projectId, likeQuery, normalizedLikeQuery, limit)
        }
        const getter = statements?.searchConversationsByTitle
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(userId, likeQuery, normalizedLikeQuery, limit)
      },
      searchTopLevelMessages: ({ userId, projectId, query, limit }) => {
        if (typeof searchTopLevelUserMessages !== 'function') return []
        return searchTopLevelUserMessages({ userId, projectId, query, limit })
      },
      searchNotes: ({ userId, projectId, query, limit }) => {
        return searchNotes({ userId, query, projectId, limit })
      },
      listMessagesByConversationId: conversationId => {
        const getter = statements?.getMessagesByConversationId
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(conversationId)
      },
      listTopLevelUserMessagesByConversationId: conversationId => {
        const getter = statements?.getTopLevelUserMessagesByConversationId
        if (!getter || typeof getter.all !== 'function') return []
        return getter.all(conversationId)
      },
      getMessageById: messageId => {
        const getter = statements?.getMessageById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(messageId)
      },
    })
  })

  builtInTools.set('internalLink', async (args, options) => {
    return await executeInternalLink(args, {
      currentConversationId: options?.conversationId ?? null,
      getConversationById: conversationId => {
        const getter = statements?.getConversationById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(conversationId)
      },
      getMessageById: messageId => {
        const getter = statements?.getMessageById
        if (!getter || typeof getter.get !== 'function') return undefined
        return getter.get(messageId)
      },
    })
  })

  builtInTools.set('custom_tool_manager', async (args, options) => {
    return await executeCustomToolManager(args, {
      rootPath: options?.rootPath,
      operationMode: options?.operationMode,
      conversationId: options?.conversationId ?? null,
      messageId: options?.messageId ?? null,
      streamId: options?.streamId ?? null,
      cwd: options?.rootPath,
    })
  })

  builtInTools.set('mcp_manager', async args => {
    return await executeMcpManagerTool(args)
  })

  builtInTools.set('skill_manager', async args => {
    return await executeSkillManager(args)
  })

  console.log(`[LocalServer] Initialized ${builtInTools.size} built-in tools`)
}

type LocalToolExecutionOptions = {
  rootPath?: string
  operationMode?: 'plan' | 'execute'
  conversationId?: string | null
  messageId?: string | null
  streamId?: string | null
}

type HermesYggMcpToolDefinition = {
  name: string
  description?: string
  inputSchema: Record<string, any>
  _meta?: Record<string, any>
}

type HermesYggMcpContentBlock = {
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
  resource?: {
    uri: string
    mimeType?: string
    text?: string
  }
}

const HERMES_YGG_MCP_PROTOCOL_VERSION = '2025-11-25'
const HERMES_YGG_MCP_SESSION_ID = 'ygg-hermes-tools'
const HERMES_YGG_EXPOSED_BUILTIN_TOOL_NAMES = new Set([
  'todo_list',
  'fetch_notes',
  'fetch_chats',
  'internalLink',
  'read_file',
  'read_file_continuation',
  'read_files',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'directory',
  'view_image',
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
])

const HERMES_YGG_EXPOSED_BUILTIN_TOOLS: HermesYggMcpToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.filter(tool =>
  HERMES_YGG_EXPOSED_BUILTIN_TOOL_NAMES.has(tool.name)
).map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}))

function getHermesYggMcpAuthToken(): string | null {
  const token = process.env.YGG_HERMES_MCP_AUTH_TOKEN?.trim()
  return token || null
}

function getHermesYggRequestRootPath(rawHeader: unknown): string | undefined {
  return typeof rawHeader === 'string' && rawHeader.trim() ? rawHeader.trim() : undefined
}

async function executeLocalToolByName(
  toolName: string,
  args: any,
  toolOptions: LocalToolExecutionOptions = {}
): Promise<ToolResult> {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : toolName
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

  let result: ToolResult

  const builtInHandler = builtInTools.get(normalizedToolName)
  if (builtInHandler) {
    if (shouldUseUtilityRuntimeForTool(normalizedToolName)) {
      try {
        result = await utilityToolRuntimeHost.executeTool(normalizedToolName, parsedArgs, toolOptions)
      } catch (utilityError) {
        if (isUtilityRuntimeFallbackDisabled()) {
          throw utilityError
        }
        console.warn(
          `[LocalServer] Utility runtime failed for ${normalizedToolName}; falling back to local execution:`,
          utilityError
        )
        result = await builtInHandler(parsedArgs, toolOptions)
      }
    } else {
      result = await builtInHandler(parsedArgs, toolOptions)
    }
  } else if (typeof normalizedToolName === 'string' && normalizedToolName.startsWith('mcp__')) {
    if (!mcpManager) {
      result = { success: false, error: 'MCP manager not initialized' }
    } else {
      try {
        const mcpResult = await mcpManager.callTool(normalizedToolName, parsedArgs)
        const textContent = mcpResult.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
        result = {
          success: !mcpResult.isError,
          content: mcpResult.content,
          text: textContent,
          error: mcpResult.isError ? textContent : undefined,
        }
      } catch (mcpError) {
        console.error('[LocalServer] MCP tool error:', mcpError)
        result = { success: false, error: mcpError instanceof Error ? mcpError.message : String(mcpError) }
      }
    }
  } else if (customToolRegistry.hasCustomTool(normalizedToolName)) {
    if (shouldUseUtilityRuntimeForCustomTool(normalizedToolName)) {
      try {
        result = await utilityToolRuntimeHost.executeTool(normalizedToolName, parsedArgs, toolOptions)
      } catch (utilityError) {
        if (isUtilityRuntimeFallbackDisabled()) {
          throw utilityError
        }
        console.warn(
          `[LocalServer] Utility runtime failed for custom tool ${normalizedToolName}; falling back to local execution:`,
          utilityError
        )
        result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
          rootPath: toolOptions.rootPath,
          operationMode: toolOptions.operationMode,
          conversationId: toolOptions.conversationId ?? null,
          messageId: toolOptions.messageId ?? null,
          streamId: toolOptions.streamId ?? null,
          cwd: toolOptions.rootPath,
        })
      }
    } else {
      result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
        rootPath: toolOptions.rootPath,
        operationMode: toolOptions.operationMode,
        conversationId: toolOptions.conversationId ?? null,
        messageId: toolOptions.messageId ?? null,
        streamId: toolOptions.streamId ?? null,
        cwd: toolOptions.rootPath,
      })
    }
  } else {
    console.warn(`[LocalServer] Unknown tool: ${normalizedToolName}`)
    result = { success: false, error: `Unknown tool: ${normalizedToolName}` }
  }

  return result
}

function toHermesYggMcpToolDefinitionFromMcpTool(tool: any): HermesYggMcpToolDefinition | null {
  const visibility = tool?._meta?.ui?.visibility
  if (Array.isArray(visibility) && !visibility.includes('model')) {
    return null
  }

  const name = typeof tool?.qualifiedName === 'string' ? tool.qualifiedName : typeof tool?.name === 'string' ? tool.name : null
  if (!name) return null

  return {
    name,
    description: typeof tool?.description === 'string' ? tool.description : undefined,
    inputSchema:
      tool?.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    _meta: tool?._meta && typeof tool._meta === 'object' ? tool._meta : undefined,
  }
}

function listHermesYggMcpTools(): HermesYggMcpToolDefinition[] {
  const tools: HermesYggMcpToolDefinition[] = [...HERMES_YGG_EXPOSED_BUILTIN_TOOLS]

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
    // Ignore custom-tool discovery failures in MCP listing.
  }

  try {
    const mcpTools = mcpManager
      .getAllTools()
      .map(toHermesYggMcpToolDefinitionFromMcpTool)
      .filter((tool): tool is HermesYggMcpToolDefinition => !!tool)
    tools.push(...mcpTools)
  } catch {
    // Ignore upstream MCP listing failures in MCP listing.
  }

  const deduped = new Map<string, HermesYggMcpToolDefinition>()
  for (const tool of tools) {
    if (!tool?.name) continue
    if (!deduped.has(tool.name)) {
      deduped.set(tool.name, tool)
    }
  }

  return Array.from(deduped.values())
}

function stringifyHermesYggMcpText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toHermesYggMcpContent(result: any): HermesYggMcpContentBlock[] {
  if (Array.isArray(result?.content)) {
    const contentBlocks = result.content
      .map((block: any): HermesYggMcpContentBlock | null => {
        if (!block || typeof block !== 'object') {
          const text = stringifyHermesYggMcpText(block)
          return text ? { type: 'text', text } : null
        }

        if (block.type === 'text' && typeof block.text === 'string') {
          return { type: 'text', text: block.text }
        }

        if (block.type === 'image' && typeof block.data === 'string') {
          return { type: 'image', data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined }
        }

        if (block.type === 'resource' && block.resource && typeof block.resource.uri === 'string') {
          return {
            type: 'resource',
            resource: {
              uri: block.resource.uri,
              mimeType: typeof block.resource.mimeType === 'string' ? block.resource.mimeType : undefined,
              text: typeof block.resource.text === 'string' ? block.resource.text : undefined,
            },
          }
        }

        const text = stringifyHermesYggMcpText(block)
        return text ? { type: 'text', text } : null
      })
      .filter((block): block is HermesYggMcpContentBlock => !!block)

    if (contentBlocks.length > 0) {
      return contentBlocks
    }
  }

  const fallbackText =
    (typeof result?.text === 'string' && result.text) ||
    (typeof result?.error === 'string' && result.error) ||
    stringifyHermesYggMcpText(result)

  return [{ type: 'text', text: fallbackText || 'Tool completed with no output.' }]
}

function toHermesYggMcpToolCallResult(result: any): { content: HermesYggMcpContentBlock[]; isError?: boolean } {
  return {
    content: toHermesYggMcpContent(result),
    isError: result?.success === false || result?.isError === true,
  }
}

function setHermesYggMcpResponseHeaders(res: any): void {
  res.setHeader('mcp-protocol-version', HERMES_YGG_MCP_PROTOCOL_VERSION)
  res.setHeader('mcp-session-id', HERMES_YGG_MCP_SESSION_ID)
}

function sendHermesYggMcpJsonResult(res: any, id: unknown, result: any, statusCode = 200): void {
  setHermesYggMcpResponseHeaders(res)
  if (id === undefined || id === null) {
    res.status(202).end()
    return
  }
  res.status(statusCode).json({ jsonrpc: '2.0', id, result })
}

function sendHermesYggMcpJsonError(
  res: any,
  id: unknown,
  code: number,
  message: string,
  statusCode = 200
): void {
  setHermesYggMcpResponseHeaders(res)
  if (id === undefined || id === null) {
    res.status(statusCode).json({ error: message })
    return
  }
  res.status(statusCode).json({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

function registerCustomToolsWithOrchestrator(): number {
  const definitions = customToolRegistry.getDefinitions()
  for (const customToolDef of definitions) {
    toolOrchestrator.registerTool(customToolDef.name, async (args, options) => {
      if (shouldUseUtilityRuntimeForCustomTool(customToolDef.name)) {
        try {
          return await utilityToolRuntimeHost.executeTool(customToolDef.name, args, {
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

    if (!utilityRuntimeAvailable) {
      return
    }

    void utilityToolRuntimeHost
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

const app = express()
let server: any = null
let wss: WebSocketServer | null = null
let oauthCallbackServer: any = null // OAuth callback server on port 1455
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
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      heartbeat_time TEXT,
      agent_name TEXT,
      model TEXT,
      model_context_length INTEGER,
      loop_interval_ms INTEGER,
      auto_resume INTEGER,
      tool_allowlist TEXT,
      work_directory TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Keep bootstrap insert schema-agnostic for legacy DBs.
  // Column backfills are handled below via ALTER TABLE migrations.
  db.exec(`INSERT OR IGNORE INTO agent_settings (id) VALUES (1)`)

  // Ensure new columns exist if older DB is present
  try {
    const columns = db.prepare(`PRAGMA table_info(agent_settings)`).all() as { name: string }[]
    const columnNames = new Set(columns.map(col => col.name))
    if (!columnNames.has('agent_name')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN agent_name TEXT`)
    }
    if (!columnNames.has('model')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN model TEXT`)
    }
    if (!columnNames.has('model_context_length')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN model_context_length INTEGER`)
    }
    if (!columnNames.has('loop_interval_ms')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN loop_interval_ms INTEGER`)
    }
    if (!columnNames.has('auto_resume')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN auto_resume INTEGER`)
    }
    if (!columnNames.has('tool_allowlist')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN tool_allowlist TEXT`)
    }
    if (!columnNames.has('work_directory')) {
      db.exec(`ALTER TABLE agent_settings ADD COLUMN work_directory TEXT`)
    }
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate agent_settings table:', error)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'stopped',
      session_id INTEGER,
      conversation_id TEXT,
      stream_id TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    )
  `)

  db.exec(`INSERT OR IGNORE INTO agent_state (id, status) VALUES (1, 'stopped')`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary_message_id TEXT,
      rollover_reason TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      session_id INTEGER,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL DEFAULT 'user',
      description TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_summaries (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      summary_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
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
      CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_insert
      AFTER INSERT ON note_search_docs
      BEGIN
        INSERT INTO note_search_fts (message_id, conversation_title, note)
        VALUES (
          NEW.message_id,
          COALESCE(NEW.conversation_title, ''),
          COALESCE(NEW.note, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_update
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

      CREATE TRIGGER IF NOT EXISTS note_search_docs_fts_delete
      AFTER DELETE ON note_search_docs
      BEGIN
        DELETE FROM note_search_fts WHERE message_id = OLD.message_id;
      END;

      CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_insert
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
        WHERE c.id = NEW.conversation_id;

        INSERT OR REPLACE INTO note_search_embedding_state (
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
        );
      END;

      CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_update
      AFTER UPDATE ON messages
      BEGIN
        DELETE FROM note_search_docs WHERE message_id = OLD.id;
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
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0;

        DELETE FROM note_search_embedding_state
        WHERE message_id = OLD.id
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) = 0;

        INSERT OR REPLACE INTO note_search_embedding_state (
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
          s.embedding_model,
          s.embedding_dimensions,
          s.embedding_updated_at,
          'stale',
          NULL
        FROM note_search_embedding_state s
        WHERE s.message_id = OLD.id
          AND LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0;

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
          NEW.id,
          NULL,
          NULL,
          NULL,
          NULL,
          'pending',
          NULL
        WHERE LENGTH(TRIM(COALESCE(NEW.note, ''))) > 0;
      END;

      CREATE TRIGGER IF NOT EXISTS note_search_docs_from_messages_delete
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM note_search_docs WHERE message_id = OLD.id;
        DELETE FROM note_search_embedding_state WHERE message_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS note_search_docs_from_conversations_update
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
    // Users
    upsertUser: db.prepare(`
        INSERT INTO users (id, username, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username
      `),

    // Projects
    upsertProject: db.prepare(`
        INSERT INTO projects (id, name, user_id, context, system_prompt, storage_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          context = excluded.context,
          system_prompt = excluded.system_prompt,
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
    getLocalConversationsByUserAndProject: db.prepare(
      "SELECT * FROM conversations WHERE user_id = ? AND project_id = ? AND storage_mode = 'local' ORDER BY updated_at DESC"
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

    // Agent Settings
    getAgentSettings: db.prepare(
      'SELECT heartbeat_time, agent_name, model, model_context_length, loop_interval_ms, auto_resume, tool_allowlist, work_directory, updated_at FROM agent_settings WHERE id = 1'
    ),
    upsertAgentSettings: db.prepare(`
        INSERT INTO agent_settings (id, heartbeat_time, agent_name, model, model_context_length, loop_interval_ms, auto_resume, tool_allowlist, work_directory, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          heartbeat_time = excluded.heartbeat_time,
          agent_name = excluded.agent_name,
          model = excluded.model,
          model_context_length = excluded.model_context_length,
          loop_interval_ms = excluded.loop_interval_ms,
          auto_resume = excluded.auto_resume,
          tool_allowlist = excluded.tool_allowlist,
          work_directory = excluded.work_directory,
          updated_at = CURRENT_TIMESTAMP
      `),

    // Agent State
    getAgentState: db.prepare(
      'SELECT status, session_id, conversation_id, stream_id, last_run_at, next_run_at, updated_at FROM agent_state WHERE id = 1'
    ),
    upsertAgentState: db.prepare(`
        INSERT INTO agent_state (id, status, session_id, conversation_id, stream_id, last_run_at, next_run_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          session_id = excluded.session_id,
          conversation_id = excluded.conversation_id,
          stream_id = excluded.stream_id,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          updated_at = CURRENT_TIMESTAMP
      `),

    // Agent Sessions
    createAgentSession: db.prepare(`
        INSERT INTO agent_sessions (conversation_id, started_at, rollover_reason)
        VALUES (?, ?, ?)
      `),
    endAgentSession: db.prepare(
      'UPDATE agent_sessions SET ended_at = ?, summary_message_id = ?, rollover_reason = ? WHERE id = ?'
    ),
    getLatestAgentSession: db.prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT 1'),
    getAgentSessionById: db.prepare('SELECT * FROM agent_sessions WHERE id = ?'),

    // Agent Tasks
    createAgentTask: db.prepare(`
        INSERT INTO agent_tasks (id, session_id, status, priority, source, description, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
    getAgentTasks: db.prepare('SELECT * FROM agent_tasks ORDER BY created_at ASC'),
    getAgentTasksByStatus: db.prepare('SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at ASC'),
    getAgentTaskById: db.prepare('SELECT * FROM agent_tasks WHERE id = ?'),
    updateAgentTaskStatus: db.prepare(`
        UPDATE agent_tasks
        SET status = ?, started_at = ?, completed_at = ?, error = ?
        WHERE id = ?
      `),

    // Agent Summaries
    createAgentSummary: db.prepare(`
        INSERT INTO agent_summaries (id, session_id, summary_text, created_at)
        VALUES (?, ?, ?, ?)
      `),

    // Message updates (for local editing)
    updateMessage: db.prepare('UPDATE messages SET content = ?, note = ?, note_color = ?, content_blocks = ? WHERE id = ?'),
  }

  Object.assign(statements, createToolsStatements(db))
  pruneOldTools(statements)
}

// Helper functions to ensure dependencies exist before sync operations
function ensureUserExists(userId: string) {
  if (!db) return
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
  if (!existing) {
    // console.log('[LocalServer] Auto-creating user stub:', userId)
    db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(
      userId,
      `synced-user-${userId.substring(0, 8)}`,
      new Date().toISOString()
    )
  }
}

function ensureProjectExists(projectId: string, userId: string) {
  if (!db) return
  ensureUserExists(userId) // Project requires user to exist
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
  if (!existing) {
    // console.log('[LocalServer] Auto-creating project stub:', projectId)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO projects (id, name, user_id, context, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, 'Synced Project', userId, null, null, now, now)
  }
}

function ensureConversationExists(conversationId: string, userId: string, projectId?: string | null) {
  if (!db) return
  ensureUserExists(userId) // Conversation requires user to exist
  if (projectId) {
    ensureProjectExists(projectId, userId) // If project is set, ensure it exists
  }
  const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)
  if (!existing) {
    // console.log('[LocalServer] Auto-creating conversation stub:', conversationId)
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO conversations (id, project_id, user_id, title, model_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(conversationId, projectId || null, userId, 'Synced Conversation', 'unknown', now, now)
  }
}

// Helper to save generated images from image-generating models to local storage
function getGeneratedImageExtension(mimeType: string): string {
  const normalized = (mimeType || 'image/png').toLowerCase().split(';')[0].trim()
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
  if (normalized === 'image/svg+xml') return 'svg'
  return normalized.startsWith('image/') ? normalized.slice('image/'.length) || 'png' : 'png'
}

function createGeneratedImageShortId(): string {
  if (!db) return `img-${Date.now()}`
  const row = db.prepare(`
    SELECT short_id FROM message_attachments
    WHERE short_id LIKE 'img-%'
    ORDER BY CAST(substr(short_id, 5) AS INTEGER) DESC
    LIMIT 1
  `).get() as { short_id?: string | null } | undefined
  const last = typeof row?.short_id === 'string' ? Number.parseInt(row.short_id.replace(/^img-/, ''), 10) : 0
  const next = Number.isFinite(last) ? last + 1 : 1
  return `img-${String(next).padStart(4, '0')}`
}

function extractGeneratedImageFilePathsFromContentBlocks(contentBlocks: any): string[] {
  const parsed = typeof contentBlocks === 'string' ? (() => {
    try { return JSON.parse(contentBlocks) } catch { return [] }
  })() : contentBlocks
  if (!Array.isArray(parsed)) return []

  const paths: string[] = []
  for (const block of parsed) {
    if (!block || typeof block !== 'object') continue
    const candidate = typeof block.filePath === 'string' ? block.filePath : typeof block.file_path === 'string' ? block.file_path : null
    if (candidate && block.type === 'image') paths.push(candidate)
  }
  return Array.from(new Set(paths))
}

async function saveGeneratedImage(
  messageId: string,
  imageUrl: string,
  mimeType: string = 'image/png'
): Promise<{ filePath: string; attachmentId: string } | null> {
  if (!db || !statements || !currentDbPath) {
    console.error('[LocalServer] Database not initialized for saving generated image')
    return null
  }

  try {
    console.log('[LocalServer] Saving generated image', {
      messageId,
      mimeType,
      sourceType: imageUrl.startsWith('data:') ? 'data-url' : 'url',
      sourceLength: imageUrl.length,
    })
    // Download the image
    const response = await fetch(imageUrl)
    if (!response.ok) {
      console.error('[LocalServer] Failed to download image:', imageUrl, response.statusText)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())

    // Calculate SHA256 for deduplication
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')

    const now = new Date().toISOString()

    // Check if attachment with this sha256 already exists (deduplication)
    const existingAttachment = statements.getAttachmentBySha256.get(sha256) as
      | { id: string; file_path: string; short_id?: string | null }
      | undefined

    const ext = getGeneratedImageExtension(mimeType)
    const imagesDir = path.join(path.dirname(currentDbPath), 'generated_images')

    // Ensure directory exists
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true })
    }

    let attachmentId: string
    let shortId = typeof existingAttachment?.short_id === 'string' && existingAttachment.short_id.trim()
      ? existingAttachment.short_id.trim()
      : createGeneratedImageShortId()
    let filePath = path.join(imagesDir, `${shortId}.${ext}`)

    if (existingAttachment) {
      // Reuse existing attachment metadata, but prefer the short generated-image path.
      attachmentId = existingAttachment.id
      if (typeof existingAttachment.file_path === 'string' && existingAttachment.file_path.trim()) {
        filePath = existingAttachment.file_path
      }
    } else {
      while (fs.existsSync(filePath)) {
        shortId = createGeneratedImageShortId()
        filePath = path.join(imagesDir, `${shortId}.${ext}`)
      }
      fs.writeFileSync(filePath, buffer)

      // Create new attachment record
      attachmentId = uuidv4()
      statements.upsertAttachment.run(
        attachmentId,
        messageId,
        'image',
        mimeType,
        'file',
        null, // url
        filePath,
        null, // width
        null, // height
        buffer.length,
        sha256,
        now,
        shortId
      )
    }

    // Link attachment to message (INSERT OR IGNORE handles duplicate links gracefully)
    statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)

    try {
      const messageRow = db.prepare('SELECT content_blocks FROM messages WHERE id = ?').get(messageId) as { content_blocks?: string | null } | undefined
      const blocks = messageRow?.content_blocks ? JSON.parse(messageRow.content_blocks) : []
      if (Array.isArray(blocks)) {
        let changed = false
        const updatedBlocks = blocks.map((block: any) => {
          if (block?.type === 'image' && typeof block.url === 'string' && block.url === imageUrl) {
            changed = true
            return { ...block, filePath, file_path: filePath, attachmentId, attachment_id: attachmentId, shortId, short_id: shortId, sha256 }
          }
          return block
        })
        if (changed) {
          db.prepare('UPDATE messages SET content_blocks = ? WHERE id = ?').run(JSON.stringify(updatedBlocks), messageId)
        }
      }
    } catch (metadataError) {
      console.warn('[LocalServer] Failed to annotate generated image content block with file path:', metadataError)
    }

    return { filePath, attachmentId }
  } catch (error) {
    console.error('[LocalServer] Error saving generated image:', error)
    return null
  }
}

// ChatNode interface for message tree structure
interface ChatNode {
  id: string
  message: string
  sender: 'user' | 'assistant'
  children: ChatNode[]
}

// Build tree structure from flat message array with children_ids
function buildMessageTree(messages: any[]): ChatNode | null {
  if (!messages || messages.length === 0) return null

  const messageMap = new Map<string, ChatNode>()
  const rootNodes: ChatNode[] = []

  // Create nodes
  messages.forEach(msg => {
    messageMap.set(msg.id, {
      id: msg.id.toString(),
      message: msg.content,
      sender: msg.role as 'user' | 'assistant',
      children: [],
    })
  })

  // Build tree using children_ids and collect all root nodes
  messages.forEach(msg => {
    const node = messageMap.get(msg.id)!

    if (msg.parent_id === null) {
      rootNodes.push(node)
    }

    // Add children using children_ids array
    const childIds = msg.children_ids || []
    childIds.forEach((childId: string) => {
      const childNode = messageMap.get(childId)
      if (childNode) {
        node.children.push(childNode)
      }
    })
  })

  if (rootNodes.length === 0) return null

  // If only one root message, return it directly
  if (rootNodes.length === 1) {
    return rootNodes[0]
  }

  // Multiple roots → create a synthetic root node containing all root branches
  // This preserves all independent conversation trees
  return {
    id: 'root',
    message: 'Conversation',
    sender: 'assistant',
    children: rootNodes,
  }
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
  app.use(
    cors({
      origin: true, // Allow all origins in local dev
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
    registerHeadlessServerRoutes(app, { db, statements })
  }
  registerProxyRoutes(app)
  registerLocalOperationsRoutes(app)
  registerSkillRoutes(app)
  registerMcpRoutes(app)
  registerLspRoutes(app)

  // ============================================================================
  // Global Agent Settings
  // ============================================================================

  // GET /api/agent-settings - Get global agent settings (local only)
  app.get('/api/agent-settings', (_req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const row = statements.getAgentSettings.get() as
        | {
            heartbeat_time?: string | null
            agent_name?: string | null
            model?: string | null
            model_context_length?: number | null
            loop_interval_ms?: number | null
            auto_resume?: number | null
            tool_allowlist?: string | null
            work_directory?: string | null
            updated_at?: string
          }
        | undefined
      let toolAllowlist: string[] | null = null
      if (row?.tool_allowlist) {
        try {
          toolAllowlist = JSON.parse(row.tool_allowlist)
        } catch {
          toolAllowlist = null
        }
      }

      res.json({
        heartbeatTime: row?.heartbeat_time ?? null,
        agentName: row?.agent_name ?? null,
        model: row?.model ?? null,
        modelContextLength: row?.model_context_length ?? null,
        loopIntervalMs: row?.loop_interval_ms ?? null,
        autoResume: row?.auto_resume ?? null,
        toolAllowlist,
        workDirectory: row?.work_directory ?? null,
        updatedAt: row?.updated_at ?? null,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error getting agent settings:', error)
      res.status(500).json({ error: 'Failed to load agent settings' })
    }
  })

  // PUT /api/agent-settings - Update global agent settings (local only)
  app.put('/api/agent-settings', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const {
        heartbeatTime,
        agentName,
        model,
        modelContextLength,
        loopIntervalMs,
        autoResume,
        toolAllowlist,
        workDirectory,
      } = req.body as {
        heartbeatTime?: string | null
        agentName?: string | null
        model?: string | null
        modelContextLength?: number | null
        loopIntervalMs?: number | null
        autoResume?: boolean | number | null
        toolAllowlist?: string[] | null
        workDirectory?: string | null
      }
      const normalized =
        typeof heartbeatTime === 'string' && heartbeatTime.trim().length > 0 ? heartbeatTime.trim() : null
      const normalizedAgentName = typeof agentName === 'string' && agentName.trim().length > 0 ? agentName.trim() : null
      const normalizedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : null
      const normalizedModelContext =
        typeof modelContextLength === 'number' && Number.isFinite(modelContextLength) && modelContextLength > 0
          ? Math.floor(modelContextLength)
          : null
      const normalizedLoopInterval =
        typeof loopIntervalMs === 'number' && Number.isFinite(loopIntervalMs) && loopIntervalMs > 0
          ? Math.floor(loopIntervalMs)
          : null
      const normalizedAutoResume = autoResume === null || autoResume === undefined ? null : autoResume ? 1 : 0
      const normalizedAllowlist =
        Array.isArray(toolAllowlist) && toolAllowlist.length > 0 ? JSON.stringify(toolAllowlist) : null
      const normalizedWorkDirectory =
        typeof workDirectory === 'string' && workDirectory.trim().length > 0 ? workDirectory.trim() : null

      if (normalized && !/^\d{2}:\d{2}$/.test(normalized)) {
        res.status(400).json({ error: 'heartbeatTime must be in HH:MM format or null' })
        return
      }

      statements.upsertAgentSettings.run(
        normalized,
        normalizedAgentName,
        normalizedModel,
        normalizedModelContext,
        normalizedLoopInterval,
        normalizedAutoResume,
        normalizedAllowlist,
        normalizedWorkDirectory
      )

      const row = statements.getAgentSettings.get() as
        | { heartbeat_time?: string | null; updated_at?: string }
        | undefined
      res.json({ success: true, settings: row })
    } catch (error) {
      console.error('[LocalServer] ❌ Error updating agent settings:', error)
      res.status(500).json({ error: 'Failed to update agent settings' })
    }
  })

  // GET /api/agent/state - Get global agent runtime state
  app.get('/api/agent/state', (_req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const row = statements.getAgentState.get() as
        | {
            status: string
            session_id: number | null
            conversation_id: string | null
            stream_id: string | null
            last_run_at: string | null
            next_run_at: string | null
            updated_at: string | null
          }
        | undefined
      res.json({ success: true, state: row })
    } catch (error) {
      console.error('[LocalServer] ❌ Error getting agent state:', error)
      res.status(500).json({ error: 'Failed to load agent state' })
    }
  })

  // PUT /api/agent/state - Update global agent runtime state
  app.put('/api/agent/state', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const body = (req.body ?? {}) as {
        status?: string
        sessionId?: number | null
        conversationId?: string | null
        streamId?: string | null
        lastRunAt?: string | null
        nextRunAt?: string | null
      }
      const { status, sessionId, conversationId, streamId, lastRunAt, nextRunAt } = body

      const current = statements.getAgentState.get() as any
      const hasField = (field: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, field)

      const nextStatus = hasField('status') ? (status ?? current?.status ?? 'stopped') : (current?.status ?? 'stopped')
      const nextSessionId = hasField('sessionId') ? (sessionId ?? null) : (current?.session_id ?? null)
      const nextConversationId = hasField('conversationId')
        ? (conversationId ?? null)
        : (current?.conversation_id ?? null)
      const nextStreamId = hasField('streamId') ? (streamId ?? null) : (current?.stream_id ?? null)
      const nextLastRunAt = hasField('lastRunAt') ? (lastRunAt ?? null) : (current?.last_run_at ?? null)
      const nextNextRunAt = hasField('nextRunAt') ? (nextRunAt ?? null) : (current?.next_run_at ?? null)

      statements.upsertAgentState.run(
        nextStatus,
        nextSessionId,
        nextConversationId,
        nextStreamId,
        nextLastRunAt,
        nextNextRunAt
      )

      const updated = statements.getAgentState.get()
      res.json({ success: true, state: updated })
    } catch (error) {
      console.error('[LocalServer] ❌ Error updating agent state:', error)
      res.status(500).json({ error: 'Failed to update agent state' })
    }
  })

  // POST /api/agent/tasks - Enqueue a global agent task
  app.post('/api/agent/tasks', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const {
        description,
        status = 'pending',
        priority = 'normal',
        source = 'user',
        payload,
        sessionId,
      } = req.body as {
        description?: string
        status?: string
        priority?: string
        source?: string
        payload?: any
        sessionId?: number | null
      }

      if (!description || !description.trim()) {
        res.status(400).json({ error: 'description is required' })
        return
      }

      const taskId = uuidv4()
      const now = new Date().toISOString()
      const activeSessionId = sessionId ?? (statements.getAgentState.get() as any)?.session_id ?? null
      const normalizedStatus =
        typeof status === 'string' && ['pending', 'scheduled', 'running', 'completed', 'failed'].includes(status)
          ? status
          : 'pending'

      statements.createAgentTask.run(
        taskId,
        activeSessionId,
        normalizedStatus,
        priority,
        source,
        description.trim(),
        payload ? JSON.stringify(payload) : null,
        now
      )

      const task = statements.getAgentTaskById.get(taskId)
      res.status(201).json({ success: true, task })
    } catch (error) {
      console.error('[LocalServer] ❌ Error creating agent task:', error)
      res.status(500).json({ error: 'Failed to create agent task' })
    }
  })

  // GET /api/agent/tasks - List global agent tasks
  app.get('/api/agent/tasks', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const status = req.query.status as string | undefined
      const tasks = status ? statements.getAgentTasksByStatus.all(status) : statements.getAgentTasks.all()
      res.json({ success: true, tasks })
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching agent tasks:', error)
      res.status(500).json({ error: 'Failed to fetch agent tasks' })
    }
  })

  // PATCH /api/agent/tasks/:id - Update task status
  app.patch('/api/agent/tasks/:id', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const { id } = req.params
      const { status, error } = req.body as { status?: string; error?: string | null }
      const task = statements.getAgentTaskById.get(id)
      if (!task) {
        res.status(404).json({ error: 'Task not found' })
        return
      }

      const now = new Date().toISOString()
      const startedAt = status === 'running' ? now : task.started_at
      const completedAt = status === 'completed' || status === 'failed' ? now : task.completed_at
      statements.updateAgentTaskStatus.run(status || task.status, startedAt, completedAt, error || null, id)

      const updated = statements.getAgentTaskById.get(id)
      res.json({ success: true, task: updated })
    } catch (error) {
      console.error('[LocalServer] ❌ Error updating agent task:', error)
      res.status(500).json({ error: 'Failed to update agent task' })
    }
  })

  // POST /api/agent/session/start - Start a new agent session
  app.post('/api/agent/session/start', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const { conversationId, rolloverReason } = req.body as {
        conversationId?: string | null
        rolloverReason?: string | null
      }
      const now = new Date().toISOString()
      const info = statements.createAgentSession.run(conversationId || null, now, rolloverReason || null)
      const sessionId = Number(info.lastInsertRowid)

      const currentState = statements.getAgentState.get() as any
      statements.upsertAgentState.run(
        currentState?.status || 'idle',
        sessionId,
        conversationId || null,
        currentState?.stream_id ?? null,
        currentState?.last_run_at ?? null,
        currentState?.next_run_at ?? null
      )

      const session = statements.getAgentSessionById.get(sessionId)
      res.status(201).json({ success: true, session })
    } catch (error) {
      console.error('[LocalServer] ❌ Error creating agent session:', error)
      res.status(500).json({ error: 'Failed to create agent session' })
    }
  })

  // POST /api/agent/session/end - End the current agent session
  app.post('/api/agent/session/end', (req, res) => {
    try {
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const { sessionId, summaryMessageId, rolloverReason } = req.body as {
        sessionId?: number
        summaryMessageId?: string | null
        rolloverReason?: string | null
      }
      const state = statements.getAgentState.get() as any
      const targetSessionId = sessionId ?? state?.session_id
      if (!targetSessionId) {
        res.status(400).json({ error: 'sessionId is required' })
        return
      }

      const now = new Date().toISOString()
      statements.endAgentSession.run(now, summaryMessageId || null, rolloverReason || null, targetSessionId)
      const updated = statements.getAgentSessionById.get(targetSessionId)
      res.json({ success: true, session: updated })
    } catch (error) {
      console.error('[LocalServer] ❌ Error ending agent session:', error)
      res.status(500).json({ error: 'Failed to end agent session' })
    }
  })

  // =====================================================
  // OpenAI ChatGPT OAuth Authentication Endpoints
  // For personal use with ChatGPT Plus/Pro subscriptions
  // =====================================================

  // OAuth Configuration (from OpenAI Codex CLI)
  const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
  const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
  const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
  const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
  const OPENAI_SCOPE = 'openid profile email offline_access'

  // OAuth state storage (in-memory, per session)
  const oauthPendingFlows = new Map<string, { verifier: string; state: string; createdAt: number }>()
  // Storage for completed OAuth tokens (keyed by state, for frontend to retrieve)
  const oauthCompletedTokens = new Map<
    string,
    {
      accessToken: string
      refreshToken: string
      expiresAt: number
      accountId: string
      createdAt: number
    }
  >()

  // Clean up old pending flows and completed tokens (older than 10 minutes)
  setInterval(() => {
    const now = Date.now()
    for (const [state, flow] of oauthPendingFlows.entries()) {
      if (now - flow.createdAt > 10 * 60 * 1000) {
        oauthPendingFlows.delete(state)
      }
    }
    for (const [state, tokens] of oauthCompletedTokens.entries()) {
      if (now - tokens.createdAt > 10 * 60 * 1000) {
        oauthCompletedTokens.delete(state)
      }
    }
  }, 60 * 1000)

  // Start OAuth callback server on port 1455
  // This is a dedicated server just for handling OAuth redirects
  function startOAuthCallbackServer() {
    const oauthApp = express()
    oauthApp.use(cors())

    oauthApp.get('/auth/callback', async (req, res) => {
      try {
        const { code, state } = req.query as { code?: string; state?: string }

        if (!code || !state) {
          res.status(400).send('Missing code or state parameter')
          return
        }

        const pendingFlow = oauthPendingFlows.get(state)
        if (!pendingFlow) {
          res.status(400).send('Invalid or expired state. Please try again.')
          return
        }

        // Exchange code for tokens
        const tokenRes = await fetch(OPENAI_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: OPENAI_CLIENT_ID,
            code,
            code_verifier: pendingFlow.verifier,
            redirect_uri: OPENAI_REDIRECT_URI,
          }),
        })

        if (!tokenRes.ok) {
          const errorText = await tokenRes.text()
          console.error('[OAuthServer] Token exchange failed:', tokenRes.status, errorText)
          res.status(400).send('Token exchange failed. Please try again.')
          oauthPendingFlows.delete(state)
          return
        }

        const tokens = (await tokenRes.json()) as {
          access_token?: string
          refresh_token?: string
          expires_in?: number
        }

        if (!tokens.access_token || !tokens.refresh_token) {
          res.status(400).send('Invalid token response')
          oauthPendingFlows.delete(state)
          return
        }

        // Extract account ID from JWT
        let accountId = ''
        try {
          const parts = tokens.access_token.split('.')
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
            accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
          }
        } catch (e) {
          console.error('[OAuthServer] Failed to decode JWT:', e)
        }

        // Store tokens for frontend to retrieve
        const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000
        oauthCompletedTokens.set(state, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          accountId,
          createdAt: Date.now(),
        })

        // Clean up pending flow
        oauthPendingFlows.delete(state)

        // Return success page with token data
        const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>OpenAI Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .container { text-align: center; padding: 40px; background: rgba(255,255,255,0.1); border-radius: 16px; backdrop-filter: blur(10px); max-width: 500px; }
    h1 { color: #10b981; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
    .token-box { background: rgba(0,0,0,0.3); padding: 16px; border-radius: 8px; margin: 16px 0; text-align: left; }
    .token-box code { word-break: break-all; font-size: 11px; color: #a5f3fc; }
    .copy-btn { background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 16px; }
    .copy-btn:hover { background: #059669; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✓</div>
    <h1>Authentication Successful!</h1>
    
    <button class="copy-btn" onclick="copyCode()">Copy Code</button>
    <p style="font-size: 12px; opacity: 0.6; margin-top: 24px;">Or close this window if the app detected the callback automatically.</p>
  </div>
  <script>
    function copyCode() {
      navigator.clipboard.writeText(document.getElementById('authCode').textContent);
      document.querySelector('.copy-btn').textContent = 'Copied!';
      setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy Code', 2000);
    }
    // Try to notify parent/opener
    if (window.opener) {
      window.opener.postMessage({
        type: 'openai_oauth_success',
        accessToken: ${JSON.stringify(tokens.access_token)},
        refreshToken: ${JSON.stringify(tokens.refresh_token)},
        expiresIn: ${tokens.expires_in || 3600},
        accountId: ${JSON.stringify(accountId)}
      }, '*');
    }
  </script>
</body>
</html>
        `
        res.setHeader('Content-Type', 'text/html')
        res.send(successHtml)
      } catch (error) {
        console.error('[OAuthServer] Callback error:', error)
        res.status(500).send('Authentication failed. Please try again.')
      }
    })

    oauthCallbackServer = oauthApp.listen(1455, '127.0.0.1', () => {
      console.log('[OAuthServer] OAuth callback server running on http://127.0.0.1:1455')
    })

    oauthCallbackServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('[OAuthServer] Port 1455 already in use, OAuth callbacks may not work')
      } else {
        console.error('[OAuthServer] Server error:', err)
      }
    })
  }

  // Helper: Generate PKCE verifier and challenge
  async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
    const verifierBytes = crypto.randomBytes(32)
    const verifier = verifierBytes.toString('base64url')
    const challengeHash = crypto.createHash('sha256').update(verifier).digest()
    const challenge = challengeHash.toString('base64url')
    return { verifier, challenge }
  }

  // POST /api/openai/auth/start - Start OAuth flow
  app.post('/api/openai/auth/start', async (_req, res) => {
    try {
      const { verifier, challenge } = await generatePKCE()
      const state = crypto.randomBytes(16).toString('hex')

      // Store the flow
      oauthPendingFlows.set(state, { verifier, state, createdAt: Date.now() })

      // Build authorization URL
      const url = new URL(OPENAI_AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', OPENAI_CLIENT_ID)
      url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
      url.searchParams.set('scope', OPENAI_SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'codex_cli_rs')

      res.json({
        success: true,
        authUrl: url.toString(),
        state,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth start error:', error)
      res.status(500).json({ success: false, error: 'Failed to start OAuth flow' })
    }
  })

  // POST /api/openai/auth/complete - Retrieve completed OAuth tokens
  app.post('/api/openai/auth/complete', (req, res) => {
    try {
      const { state } = req.body

      if (!state) {
        res.status(400).json({ success: false, error: 'Missing state parameter' })
        return
      }

      const tokens = oauthCompletedTokens.get(state)
      if (!tokens) {
        // Check if flow is still pending (user hasn't completed auth yet)
        if (oauthPendingFlows.has(state)) {
          res.json({ success: false, pending: true, error: 'Authentication not yet completed' })
          return
        }
        res.status(404).json({ success: false, error: 'Invalid or expired state' })
        return
      }

      // Remove tokens from storage (one-time retrieval)
      oauthCompletedTokens.delete(state)

      res.json({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth complete error:', error)
      res.status(500).json({ success: false, error: 'Failed to retrieve tokens' })
    }
  })

  // GET /auth/callback - OAuth callback (port 1455 redirects to whichever local API port is active)
  // Note: The actual callback server runs on port 1455
  app.get('/auth/callback', async (req, res) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string }

      if (!code || !state) {
        res.status(400).send('Missing code or state parameter')
        return
      }

      const pendingFlow = oauthPendingFlows.get(state)
      if (!pendingFlow) {
        res.status(400).send('Invalid or expired state. Please try again.')
        return
      }

      // Exchange code for tokens
      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code,
          code_verifier: pendingFlow.verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token exchange failed:', tokenRes.status, errorText)
        res.status(400).send('Token exchange failed. Please try again.')
        oauthPendingFlows.delete(state)
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).send('Invalid token response')
        oauthPendingFlows.delete(state)
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      // Clean up
      oauthPendingFlows.delete(state)

      // Return success page with token data (will be picked up by frontend)
      const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>OpenAI Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .container { text-align: center; padding: 40px; background: rgba(255,255,255,0.1); border-radius: 16px; backdrop-filter: blur(10px); }
    h1 { color: #10b981; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✓</div>
    <h1>Authentication Successful!</h1>
    <p>You can close this window and return to the app.</p>
    <p style="font-size: 12px; opacity: 0.6;">Your ChatGPT Plus/Pro account is now connected.</p>
  </div>
  <script>
    // Send tokens to opener window if available
    if (window.opener) {
      window.opener.postMessage({
        type: 'openai_oauth_success',
        accessToken: ${JSON.stringify(tokens.access_token)},
        refreshToken: ${JSON.stringify(tokens.refresh_token)},
        expiresIn: ${tokens.expires_in || 3600},
        accountId: ${JSON.stringify(accountId)}
      }, '*');
      setTimeout(() => window.close(), 2000);
    }
  </script>
</body>
</html>
      `
      res.setHeader('Content-Type', 'text/html')
      res.send(successHtml)
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth callback error:', error)
      res.status(500).send('Authentication failed. Please try again.')
    }
  })

  // POST /api/openai/auth/exchange - Exchange code for tokens (manual flow)
  app.post('/api/openai/auth/exchange', async (req, res) => {
    try {
      const { code, state } = req.body

      if (!code || !state) {
        res.status(400).json({ success: false, error: 'Missing code or state' })
        return
      }

      const pendingFlow = oauthPendingFlows.get(state)
      if (!pendingFlow) {
        res.status(400).json({ success: false, error: 'Invalid or expired state' })
        return
      }

      // Exchange code for tokens
      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code,
          code_verifier: pendingFlow.verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token exchange failed:', tokenRes.status, errorText)
        oauthPendingFlows.delete(state)
        res.status(400).json({ success: false, error: 'Token exchange failed' })
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        oauthPendingFlows.delete(state)
        res.status(400).json({ success: false, error: 'Invalid token response' })
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      oauthPendingFlows.delete(state)

      res.json({
        success: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in || 3600,
        accountId,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth exchange error:', error)
      res.status(500).json({ success: false, error: 'Token exchange failed' })
    }
  })

  // POST /api/openai/auth/refresh - Refresh access token
  app.post('/api/openai/auth/refresh', async (req, res) => {
    try {
      const { refreshToken } = req.body

      if (!refreshToken) {
        res.status(400).json({ success: false, error: 'Missing refresh token' })
        return
      }

      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OPENAI_CLIENT_ID,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token refresh failed:', tokenRes.status, errorText)
        res.status(401).json({ success: false, error: 'Token refresh failed' })
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).json({ success: false, error: 'Invalid token response' })
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      res.json({
        success: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in || 3600,
        accountId,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth refresh error:', error)
      res.status(500).json({ success: false, error: 'Token refresh failed' })
    }
  })

  // GET /api/openai/models - Get available ChatGPT models
  app.get('/api/openai/models', (_req, res) => {
    // Return hardcoded list of ChatGPT models available with Plus/Pro subscription
    const models = [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        displayName: 'GPT-5.5',
        description: 'Latest GPT-5.5 frontier model for professional work',
        contextLength: 400000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.5-pro',
        name: 'GPT-5.5 Pro',
        displayName: 'GPT-5.5 Pro',
        description: 'Version of GPT-5.5 that produces smarter and more precise responses',
        contextLength: 400000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        displayName: 'GPT-5.4',
        description: 'Latest GPT-5.4 frontier model for professional work',
        contextLength: 400000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        displayName: 'GPT-5.4 Mini',
        description: 'Strong mini model for coding, computer use, and subagents',
        contextLength: 400000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        displayName: 'GPT-5.4 Pro',
        description: 'Version of GPT-5.4 that produces smarter and more precise responses',
        contextLength: 400000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        displayName: 'GPT-5.3 Codex',
        description: 'Latest GPT-5.3 Codex model for coding tasks',
        contextLength: 400000,
        maxCompletionTokens: 16384,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        displayName: 'GPT-4o',
        description: 'GPT-4o multimodal model',
        contextLength: 128000,
        maxCompletionTokens: 16384,
      },
    ]

    res.json({
      models: models.map(m => ({
        ...m,
        version: 'chatgpt',
        inputTokenLimit: m.contextLength,
        outputTokenLimit: m.maxCompletionTokens,
        promptCost: 0,
        completionCost: 0,
        requestCost: 0,
        thinking: true,
        supportsImages: true,
        supportsWebSearch: false,
        supportsStructuredOutputs: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        isFreeTier: false,
      })),
    })
  })

  // =====================================================
  // End of OpenAI OAuth Endpoints
  // =====================================================

  // Sync User
  app.post('/api/sync/user', (req, res) => {
    try {
      const { id, username, created_at } = req.body
      statements.upsertUser.run(id, username, created_at || new Date().toISOString())
      // console.log('[LocalServer] Synced user:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing user:', error)
      res.status(500).json({ error: 'Failed to sync user' })
    }
  })

  // Sync Project
  app.post('/api/sync/project', (req, res) => {
    try {
      const { id, name, user_id, owner_id, context, system_prompt, storage_mode, created_at, updated_at } = req.body

      // Handle owner_id -> user_id mapping (Railway sends owner_id)
      const effectiveUserId = user_id || owner_id
      if (!effectiveUserId) {
        res.status(400).json({ error: 'Missing user_id or owner_id' })
        return
      }

      // Ensure user exists before upserting project
      ensureUserExists(effectiveUserId)

      statements.upsertProject.run(
        id,
        name,
        effectiveUserId,
        context || null,
        system_prompt || null,
        storage_mode || 'cloud',
        created_at || new Date().toISOString(),
        updated_at || new Date().toISOString()
      )
      // console.log('[LocalServer] Synced project:', id, '- storage_mode:', storage_mode || 'cloud')
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing project:', error)
      res.status(500).json({ error: 'Failed to sync project' })
    }
  })

  app.delete('/api/sync/project/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteProject.run(id)
      // console.log('[LocalServer] Deleted project:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting project:', error)
      res.status(500).json({ error: 'Failed to delete project' })
    }
  })

  // Get Project (for checking existence)
  app.get('/api/sync/project/:id', (req, res) => {
    try {
      const { id } = req.params
      const project = statements.getProjectById.get(id)
      if (project) {
        res.json({ exists: true, project })
      } else {
        res.json({ exists: false })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting project:', error)
      res.status(500).json({ error: 'Failed to get project' })
    }
  })

  // Sync Conversation
  app.post('/api/sync/conversation', (req, res) => {
    try {
      const {
        id,
        project_id,
        user_id,
        owner_id, // Railway uses owner_id, local uses user_id
        title,
        model_name,
        system_prompt,
        conversation_context,
        research_note,
        cwd,
        storage_mode,
        created_at,
        updated_at,
      } = req.body

      // console.log(
      //   '[LocalServer] 🔄 POST /api/sync/conversation - conversationId:',
      //   id,
      //   'title:',
      //   title,
      //   'storage_mode:',
      //   storage_mode
      // )

      // Handle owner_id -> user_id mapping (Railway sends owner_id)
      const effectiveUserId = user_id || owner_id
      if (!effectiveUserId) {
        // console.log('[LocalServer] ❌ Missing user_id or owner_id')
        res.status(400).json({ error: 'Missing user_id or owner_id' })
        return
      }

      // console.log('[LocalServer] 👤 Effective userId:', effectiveUserId, 'projectId:', project_id)

      // Ensure dependencies exist before upserting conversation
      ensureUserExists(effectiveUserId)
      if (project_id) {
        ensureProjectExists(project_id, effectiveUserId)
      }

      statements.upsertConversation.run(
        id,
        project_id || null,
        effectiveUserId,
        title || null,
        model_name || 'unknown',
        system_prompt || null,
        conversation_context || null,
        research_note || null,
        cwd || null,
        storage_mode || 'cloud',
        created_at || new Date().toISOString(),
        updated_at || new Date().toISOString()
      )
      // console.log('[LocalServer] ✅ Synced conversation successfully:', id, '- title:', title)

      // Verify the conversation was saved
      // const saved = statements.getConversationById.get(id)
      // if (saved) {
      //   console.log(
      //     '[LocalServer] ✅ Verified conversation exists in DB:',
      //     id,
      //     '- storage_mode:',
      //     (saved as any).storage_mode
      //   )
      // } else {
      //   console.log('[LocalServer] ⚠️  Warning: Conversation not found after save:', id)
      // }

      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] ❌ Error syncing conversation:', error)
      res.status(500).json({ error: 'Failed to sync conversation' })
    }
  })

  app.delete('/api/sync/conversation/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteConversation.run(id)
      // console.log('[LocalServer] Deleted conversation:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting conversation:', error)
      res.status(500).json({ error: 'Failed to delete conversation' })
    }
  })

  // Get Conversation (for checking existence)
  app.get('/api/sync/conversation/:id', (req, res) => {
    try {
      const { id } = req.params
      const conversation = statements.getConversationById.get(id)
      if (conversation) {
        res.json({ exists: true, conversation })
      } else {
        res.json({ exists: false })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting conversation:', error)
      res.status(500).json({ error: 'Failed to get conversation' })
    }
  })

  // Sync Message
  app.post('/api/sync/message', async (req, res) => {
    try {
      const {
        id,
        conversation_id,
        parent_id,
        children_ids,
        role,
        content,
        plain_text_content,
        thinking_block,
        tool_calls,
        tool_call_id,
        model_name,
        note,
        note_color,
        ex_agent_session_id,
        ex_agent_type,
        content_blocks,
        created_at,
        // Additional context for dependency creation
        user_id,
        owner_id,
        project_id,
      } = req.body

      // console.log(
      //   '[LocalServer] 💾 POST /api/sync/message - messageId:',
      //   id,
      //   'conversationId:',
      //   conversation_id,
      //   'role:',
      //   role
      // )
      // console.log('[LocalServer] 📝 Message content preview:', content?.substring(0, 50))

      if (!conversation_id) {
        // console.log('[LocalServer] ❌ Missing conversation_id')
        res.status(400).json({ error: 'Missing conversation_id' })
        return
      }

      // Ensure conversation exists before upserting message
      // Try to get user_id from request body or from existing conversation
      let effectiveUserId = user_id || owner_id
      let effectiveProjectId = project_id

      // If no user_id provided, try to get it from the existing conversation
      if (!effectiveUserId && db) {
        const existingConv = db
          .prepare('SELECT user_id, project_id FROM conversations WHERE id = ?')
          .get(conversation_id) as { user_id: string; project_id: string | null } | undefined
        if (existingConv) {
          effectiveUserId = existingConv.user_id
          effectiveProjectId = effectiveProjectId || existingConv.project_id
        }
      }

      // If we have user context, ensure dependencies exist
      if (effectiveUserId) {
        ensureConversationExists(conversation_id, effectiveUserId, effectiveProjectId || null)
      } else {
        // No user context and conversation doesn't exist - this will fail on FK constraint
        // Log warning but proceed anyway (might succeed if conversation exists)
        console.warn('[LocalServer] No user context for message sync, conversation may not exist:', conversation_id)
      }

      const messageCreatedAt = created_at || new Date().toISOString()
      const normalizedContentBlocks =
        typeof content_blocks === 'string' ? content_blocks : JSON.stringify(content_blocks || null)

      if (role === 'assistant' || role === 'ex_agent') {
        const thinkingText = typeof thinking_block === 'string' ? thinking_block.trim() : ''
        if (thinkingText.length > 0) {
          let parsedBlocks: any[] = []
          try {
            const parsed =
              typeof normalizedContentBlocks === 'string' && normalizedContentBlocks
                ? JSON.parse(normalizedContentBlocks)
                : null
            parsedBlocks = Array.isArray(parsed) ? parsed : []
          } catch {
            parsedBlocks = []
          }

          const hasThinkingBlock = parsedBlocks.some(block => block?.type === 'thinking')
          const hasResponsesReasoning = parsedBlocks.some(block => {
            if (block?.type !== 'responses_output_items' || !Array.isArray(block?.items)) return false
            return block.items.some((item: any) => item?.type === 'reasoning')
          })

          if (!hasThinkingBlock && !hasResponsesReasoning) {
            console.debug('[LocalServer][sync/message] Assistant message has thinking_block but no reasoning persisted in content_blocks', {
              messageId: id,
              conversationId: conversation_id,
              role,
              thinkingLength: thinkingText.length,
              contentBlocksLength: parsedBlocks.length,
            })
          }
        }
      }

      statements.upsertMessage.run(
        id,
        conversation_id,
        parent_id || null,
        typeof children_ids === 'string' ? children_ids : JSON.stringify(children_ids || []),
        role,
        content,
        plain_text_content || null,
        thinking_block || null,
        typeof tool_calls === 'string' ? tool_calls : JSON.stringify(tool_calls || null),
        tool_call_id || null,
        model_name || 'unknown',
        note || null,
        note_color || null,
        ex_agent_session_id || null,
        ex_agent_type || null,
        normalizedContentBlocks,
        messageCreatedAt
      )

      // Update conversation/project timestamps to reflect recent activity
      if (db) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(messageCreatedAt, conversation_id)

        let projectIdToTouch = effectiveProjectId
        if (!projectIdToTouch) {
          const conversationRow = db
            .prepare('SELECT project_id FROM conversations WHERE id = ?')
            .get(conversation_id) as { project_id: string | null } | undefined
          projectIdToTouch = conversationRow?.project_id || null
        }

        if (projectIdToTouch) {
          db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(messageCreatedAt, projectIdToTouch)
        }
      }

      // Process any image content_blocks and save them locally before responding so the
      // caller can persist an exact generated-image path hint instead of a generic folder pattern.
      const generatedImageFilePathsSet = new Set<string>(extractGeneratedImageFilePathsFromContentBlocks(content_blocks))
      const parsedBlocks = typeof content_blocks === 'string' ? JSON.parse(content_blocks) : content_blocks
      if (Array.isArray(parsedBlocks)) {
        const imageBlocks = parsedBlocks.filter((block: any) => block.type === 'image' && block.url)
        if (imageBlocks.length > 0) {
          console.log('[LocalServer] Found generated image blocks to save', {
            messageId: id,
            count: imageBlocks.length,
            mimeTypes: imageBlocks.map((block: any) => block.mimeType || 'image/png'),
            urlTypes: imageBlocks.map((block: any) =>
              typeof block.url === 'string' && block.url.startsWith('data:') ? 'data-url' : 'url'
            ),
          })
        }
        for (const imageBlock of imageBlocks) {
          const existingPath =
            typeof imageBlock.filePath === 'string'
              ? imageBlock.filePath
              : typeof imageBlock.file_path === 'string'
                ? imageBlock.file_path
                : null
          if (existingPath && existingPath.trim()) {
            generatedImageFilePathsSet.add(existingPath.trim())
            continue
          }

          try {
            const result = await saveGeneratedImage(id, imageBlock.url, imageBlock.mimeType || 'image/png')
            console.log('[LocalServer] Generated image save result', {
              messageId: id,
              saved: Boolean(result),
              filePath: result?.filePath,
              attachmentId: result?.attachmentId,
            })
            if (result?.filePath) {
              generatedImageFilePathsSet.add(result.filePath)
            }
          } catch (err) {
            console.error('[LocalServer] Failed to save generated image:', err)
          }
        }
      } else if (content_blocks) {
        console.warn('[LocalServer] content_blocks was not an array; generated image save skipped', {
          messageId: id,
          contentBlocksType: typeof content_blocks,
        })
      }

      const generatedImageFilePaths = Array.from(generatedImageFilePathsSet)
      res.json({ success: true, id, generatedImageFilePaths })
    } catch (error) {
      console.error('[LocalServer] ❌ Error syncing message:', error)
      res.status(500).json({ error: 'Failed to sync message' })
    }
  })

  app.delete('/api/sync/message/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteMessage.run(id)
      // console.log('[LocalServer] Deleted message:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting message:', error)
      res.status(500).json({ error: 'Failed to delete message' })
    }
  })

  // Sync Attachment
  app.post('/api/sync/attachment', (req, res) => {
    try {
      const {
        id,
        message_id,
        kind,
        mime_type,
        storage,
        url,
        file_path,
        width,
        height,
        size_bytes,
        sha256,
        created_at,
      } = req.body

      let attachmentId = id

      // Check if attachment with this sha256 already exists (deduplication)
      if (sha256) {
        const existingAttachment = statements.getAttachmentBySha256.get(sha256) as { id: string } | undefined

        if (existingAttachment && existingAttachment.id !== id) {
          // Attachment with same content already exists - reuse it
          attachmentId = existingAttachment.id
        } else if (!existingAttachment) {
          // Create new attachment
          statements.upsertAttachment.run(
            id,
            message_id || null,
            kind,
            mime_type,
            storage || 'url',
            url || null,
            file_path || null,
            width || null,
            height || null,
            size_bytes || null,
            sha256,
            created_at || new Date().toISOString(),
            null
          )
        }
        // If existingAttachment.id === id, do nothing (already exists with same ID)
      } else {
        // No sha256 provided, just upsert by ID
        statements.upsertAttachment.run(
          id,
          message_id || null,
          kind,
          mime_type,
          storage || 'url',
          url || null,
          file_path || null,
          width || null,
          height || null,
          size_bytes || null,
          sha256 || null,
          created_at || new Date().toISOString(),
          null
        )
      }

      // Link attachment to message if message_id provided
      if (message_id) {
        const linkId = uuidv4()
        statements.linkAttachment.run(linkId, message_id, attachmentId, new Date().toISOString())
      }

      // console.log('[LocalServer] Synced attachment:', attachmentId)
      res.json({ success: true, id: attachmentId })
    } catch (error) {
      console.error('[LocalServer] Error syncing attachment:', error)
      res.status(500).json({ error: 'Failed to sync attachment' })
    }
  })

  // Save base64 image attachments for a message (used by local-only mode)
  app.post('/api/local/attachments/save-base64', (req, res) => {
    try {
      const { messageId, attachments } = req.body as {
        messageId: string
        attachments: Array<{
          dataUrl: string
          name?: string
          type?: string
          size?: number
        }>
      }

      if (!messageId || !attachments || !Array.isArray(attachments) || attachments.length === 0) {
        res.status(400).json({ error: 'messageId and attachments array required' })
        return
      }

      if (!db || !statements || !currentDbPath) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const savedAttachments: Array<{ id: string; file_path: string }> = []
      const imagesDir = path.join(path.dirname(currentDbPath), 'user_images')

      // Ensure directory exists
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true })
      }

      for (const attachment of attachments) {
        try {
          const { dataUrl } = attachment

          // Parse data URL: data:image/png;base64,xxxxx
          const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (!matches) {
            console.warn('[LocalServer] Invalid data URL format, skipping')
            continue
          }

          const mimeType = matches[1]
          const base64Data = matches[2]
          const buffer = Buffer.from(base64Data, 'base64')

          // Calculate SHA256 for deduplication
          const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')

          // Determine file extension
          const ext = mimeType.split('/')[1] || 'png'
          const fileName = `${sha256}.${ext}`
          const filePath = path.join(imagesDir, fileName)

          // Write file (skip if already exists - deduplication)
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, buffer)
          }

          const now = new Date().toISOString()

          // Check if attachment with this sha256 already exists (deduplication)
          const existingAttachment = statements.getAttachmentBySha256.get(sha256) as
            | { id: string; file_path: string }
            | undefined

          let attachmentId: string

          if (existingAttachment) {
            // Reuse existing attachment - just create a link to it
            attachmentId = existingAttachment.id
          } else {
            // Create new attachment record
            attachmentId = uuidv4()
            statements.upsertAttachment.run(
              attachmentId,
              messageId,
              'image',
              mimeType,
              'file',
              null, // url
              filePath,
              null, // width
              null, // height
              buffer.length,
              sha256,
              now,
              null
            )
          }

          // Link attachment to message (INSERT OR IGNORE handles duplicate links gracefully)
          statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)

          savedAttachments.push({ id: attachmentId, file_path: filePath })
        } catch (attachmentError) {
          console.error('[LocalServer] Error saving individual attachment:', attachmentError)
        }
      }

      res.json({ success: true, attachments: savedAttachments })
    } catch (error) {
      console.error('[LocalServer] Error saving base64 attachments:', error)
      res.status(500).json({ error: 'Failed to save attachments' })
    }
  })

  // Serve local attachment file by ID
  app.get('/api/local/attachments/:id/file', (req, res) => {
    try {
      const { id } = req.params

      if (!db || !statements) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const attachment = statements.getAttachmentById.get(id) as
        | {
            id: string
            file_path: string | null
            url: string | null
            mime_type: string
          }
        | undefined

      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }

      // If it's a URL-based attachment, redirect
      if (attachment.url) {
        res.redirect(attachment.url)
        return
      }

      // If it's a file-based attachment, serve the file
      if (attachment.file_path) {
        if (!fs.existsSync(attachment.file_path)) {
          res.status(404).json({ error: 'File not found on disk' })
          return
        }

        res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream')
        res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year (content-addressed)
        const stream = fs.createReadStream(attachment.file_path)
        stream.pipe(res)
        return
      }

      res.status(404).json({ error: 'No file path or URL for attachment' })
    } catch (error) {
      console.error('[LocalServer] Error serving attachment file:', error)
      res.status(500).json({ error: 'Failed to serve attachment' })
    }
  })

  // Sync Provider Cost
  app.post('/api/sync/provider-cost', (req, res) => {
    try {
      const {
        id,
        user_id,
        message_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        approx_cost,
        api_credit_cost,
        created_at,
      } = req.body

      statements.upsertProviderCost.run(
        id,
        user_id,
        message_id,
        prompt_tokens || 0,
        completion_tokens || 0,
        reasoning_tokens || 0,
        approx_cost || 0,
        api_credit_cost || 0,
        created_at || new Date().toISOString()
      )
      // console.log('[LocalServer] Synced provider cost:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing provider cost:', error)
      res.status(500).json({ error: 'Failed to sync provider cost' })
    }
  })

  // Batch sync endpoint for efficiency
  app.post('/api/sync/batch', (req, res) => {
    const { operations } = req.body as { operations: Array<{ type: string; action: string; data: any }> }

    if (!Array.isArray(operations)) {
      res.status(400).json({ error: 'Operations must be an array' })
      return
    }

    const results: Array<{ success: boolean; type: string; id?: string; error?: string }> = []

    // Use transaction for atomicity
    const transaction = db!.transaction(() => {
      for (const op of operations) {
        try {
          switch (op.type) {
            case 'user':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertUser.run(op.data.id, op.data.username, op.data.created_at || new Date().toISOString())
                results.push({ success: true, type: 'user', id: op.data.id })
              }
              break

            case 'project':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertProject.run(
                  op.data.id,
                  op.data.name,
                  op.data.user_id,
                  op.data.context || null,
                  op.data.system_prompt || null,
                  op.data.storage_mode || 'cloud',
                  op.data.created_at || new Date().toISOString(),
                  op.data.updated_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'project', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteProject.run(op.data.id)
                results.push({ success: true, type: 'project', id: op.data.id })
              }
              break

            case 'conversation':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertConversation.run(
                  op.data.id,
                  op.data.project_id || null,
                  op.data.user_id,
                  op.data.title || null,
                  op.data.model_name || 'unknown',
                  op.data.system_prompt || null,
                  op.data.conversation_context || null,
                  op.data.research_note || null,
                  op.data.cwd || null,
                  op.data.storage_mode || 'cloud',
                  op.data.created_at || new Date().toISOString(),
                  op.data.updated_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'conversation', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteConversation.run(op.data.id)
                results.push({ success: true, type: 'conversation', id: op.data.id })
              }
              break

            case 'message':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertMessage.run(
                  op.data.id,
                  op.data.conversation_id,
                  op.data.parent_id || null,
                  typeof op.data.children_ids === 'string'
                    ? op.data.children_ids
                    : JSON.stringify(op.data.children_ids || []),
                  op.data.role,
                  op.data.content,
                  op.data.plain_text_content || null,
                  op.data.thinking_block || null,
                  typeof op.data.tool_calls === 'string'
                    ? op.data.tool_calls
                    : JSON.stringify(op.data.tool_calls || null),
                  op.data.tool_call_id || null,
                  op.data.model_name || 'unknown',
                  op.data.note || null,
                  op.data.note_color || null,
                  op.data.ex_agent_session_id || null,
                  op.data.ex_agent_type || null,
                  typeof op.data.content_blocks === 'string'
                    ? op.data.content_blocks
                    : JSON.stringify(op.data.content_blocks || null),
                  op.data.created_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'message', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteMessage.run(op.data.id)
                results.push({ success: true, type: 'message', id: op.data.id })
              }
              break

            default:
              results.push({ success: false, type: op.type, error: `Unknown operation type: ${op.type}` })
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          results.push({ success: false, type: op.type, error: errorMsg })
        }
      }
    })

    try {
      transaction()
      // console.log(
      //   `[LocalServer] Batch sync completed: ${results.filter(r => r.success).length}/${operations.length} succeeded`
      // )
      res.json({ success: true, results })
    } catch (error) {
      console.error('[LocalServer] Batch sync failed:', error)
      res.status(500).json({ error: 'Batch sync failed', results })
    }
  })

  app.get('/api/hooks', async (_req, res) => {
    try {
      const hooks = await listManagedHooks()
      res.json({ success: true, hooks })
    } catch (error) {
      console.error('[LocalServer] Hook list error:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/hooks/toggle', async (req, res) => {
    try {
      const { sourceFile, event, entryIndex, handlerIndex, handlerLocation, enabled } = req.body || {}
      const hook = await setManagedHookEnabled({
        sourceFile,
        event,
        entryIndex,
        handlerIndex,
        handlerLocation,
        enabled,
      })
      res.json({ success: true, hook })
    } catch (error) {
      console.error('[LocalServer] Hook toggle error:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/hooks/run', async (req, res) => {
    try {
      const result = await runHookRequest(req.body || {})
      res.json(result)
    } catch (error) {
      console.error('[LocalServer] Hook execution error:', error)
      res.status(500).json({
        matched: false,
        hookCount: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    }
  })

  // Tool Execution Endpoint (uses built-in and custom tool registries)
  app.post('/api/tools/execute', async (req, res) => {
    try {
      const { toolName, args, rootPath, operationMode, conversationId, messageId, streamId } = req.body
      const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : toolName
      // console.log(`[LocalServer] Executing tool: ${toolName} (operationMode: ${operationMode || 'execute'})`)

      const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
      const toolOptions = {
        rootPath,
        operationMode: operationMode as 'plan' | 'execute' | undefined,
        conversationId: conversationId ?? null,
        messageId: messageId ?? null,
        streamId: streamId ?? null,
      }

      let result: ToolResult

      // Check built-in tools first
      const builtInHandler = builtInTools.get(normalizedToolName)
      if (builtInHandler) {
        if (shouldUseUtilityRuntimeForTool(normalizedToolName)) {
          try {
            result = await utilityToolRuntimeHost.executeTool(normalizedToolName, parsedArgs, toolOptions)
          } catch (utilityError) {
            if (isUtilityRuntimeFallbackDisabled()) {
              throw utilityError
            }
            console.warn(
              `[LocalServer] Utility runtime failed for ${normalizedToolName}; falling back to local execution:`,
              utilityError
            )
            result = await builtInHandler(parsedArgs, toolOptions)
          }
        } else {
          result = await builtInHandler(parsedArgs, toolOptions)
        }
      }
      // Then check MCP tools (format: mcp__serverName__toolName)
      else if (typeof normalizedToolName === 'string' && normalizedToolName.startsWith('mcp__')) {
        console.log(`[LocalServer] MCP tool detected: ${normalizedToolName}`)
        console.log(`[LocalServer] mcpManager exists: ${!!mcpManager}`)

        if (!mcpManager) {
          result = { success: false, error: 'MCP manager not initialized' }
        } else {
          try {
            const mcpResult = await mcpManager.callTool(normalizedToolName, parsedArgs)
            // Convert MCP result to standard ToolResult format
            const textContent = mcpResult.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n')
            result = {
              success: !mcpResult.isError,
              content: mcpResult.content,
              text: textContent,
              error: mcpResult.isError ? textContent : undefined,
            }
          } catch (mcpError) {
            console.error(`[LocalServer] MCP tool error:`, mcpError)
            result = { success: false, error: mcpError instanceof Error ? mcpError.message : String(mcpError) }
          }
        }
      }
      // Then check custom tools
      else if (customToolRegistry.hasCustomTool(normalizedToolName)) {
        if (shouldUseUtilityRuntimeForCustomTool(normalizedToolName)) {
          try {
            result = await utilityToolRuntimeHost.executeTool(normalizedToolName, parsedArgs, toolOptions)
          } catch (utilityError) {
            if (isUtilityRuntimeFallbackDisabled()) {
              throw utilityError
            }
            console.warn(
              `[LocalServer] Utility runtime failed for custom tool ${normalizedToolName}; falling back to local execution:`,
              utilityError
            )
            result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
              rootPath,
              operationMode: operationMode as 'plan' | 'execute' | undefined,
              conversationId: conversationId ?? null,
              messageId: messageId ?? null,
              streamId: streamId ?? null,
              cwd: rootPath,
            })
          }
        } else {
          result = await customToolRegistry.executeTool(normalizedToolName, parsedArgs, {
            rootPath,
            operationMode: operationMode as 'plan' | 'execute' | undefined,
            conversationId: conversationId ?? null,
            messageId: messageId ?? null,
            streamId: streamId ?? null,
            cwd: rootPath,
          })
        }
      }
      // Unknown tool
      else {
        console.warn(`[LocalServer] Unknown tool: ${normalizedToolName}`)
        result = { success: false, error: `Unknown tool: ${normalizedToolName}` }
      }

      res.json({ result })
    } catch (error) {
      console.error('[LocalServer] Tool execution error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.json({ result: { success: false, error: msg } })
    }
  })

  // Ygg-provided MCP endpoint for Hermes ACP sessions
  app.post('/api/mcp/ygg', async (req, res) => {
    const id = req.body?.id
    const method = typeof req.body?.method === 'string' ? req.body.method : undefined
    const authToken = getHermesYggMcpAuthToken()
    const authorizationHeader = typeof req.get('authorization') === 'string' ? req.get('authorization') : ''

    if (!authToken || authorizationHeader !== `Bearer ${authToken}`) {
      sendHermesYggMcpJsonError(res, id, -32001, 'Unauthorized MCP request', 401)
      return
    }

    if (!req.body || req.body.jsonrpc !== '2.0' || !method) {
      sendHermesYggMcpJsonError(res, id, -32600, 'Invalid JSON-RPC request', 400)
      return
    }

    if (method === 'notifications/initialized') {
      sendHermesYggMcpJsonResult(res, id, {})
      return
    }

    if (method === 'initialize') {
      sendHermesYggMcpJsonResult(res, id, {
        protocolVersion: HERMES_YGG_MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: {},
        },
        serverInfo: {
          name: 'ygg-chat',
          title: 'Ygg Chat Local Tools',
          version: '1.0.0',
        },
      })
      return
    }

    if (method === 'tools/list') {
      sendHermesYggMcpJsonResult(res, id, {
        tools: listHermesYggMcpTools(),
      })
      return
    }

    if (method === 'resources/list') {
      sendHermesYggMcpJsonResult(res, id, { resources: [] })
      return
    }

    if (method === 'prompts/list') {
      sendHermesYggMcpJsonResult(res, id, { prompts: [] })
      return
    }

    if (method === 'tools/call') {
      const toolName = req.body?.params?.name
      if (!toolName || typeof toolName !== 'string') {
        sendHermesYggMcpJsonError(res, id, -32602, 'tools/call requires a string params.name', 400)
        return
      }

      try {
        const toolResult = await executeLocalToolByName(toolName, req.body?.params?.arguments ?? {}, {
          rootPath: getHermesYggRequestRootPath(req.get('x-ygg-hermes-cwd')),
          operationMode: 'execute',
          conversationId:
            typeof req.get('x-ygg-hermes-conversation-id') === 'string' && req.get('x-ygg-hermes-conversation-id')!.trim()
              ? req.get('x-ygg-hermes-conversation-id')!.trim()
              : null,
          messageId: null,
          streamId: null,
        })

        sendHermesYggMcpJsonResult(res, id, toHermesYggMcpToolCallResult(toolResult))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendHermesYggMcpJsonResult(res, id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        })
      }
      return
    }

    sendHermesYggMcpJsonError(res, id, -32601, `Unsupported MCP method: ${method}`, 404)
  })

  // Custom Tools API Endpoints

  // GET /api/custom-tools - List all custom tool definitions
  app.get('/api/custom-tools', async (_req, res) => {
    try {
      const definitions = customToolRegistry.getDefinitions()
      const statuses = customToolRegistry.getStatuses()
      // const tools = definitions.map(tool => ({ ...tool, ui: tool.ui }))
      // redundant gpt things 
      res.json({ success: true, tools: definitions, statuses, settings: customToolRegistry.getSettings() })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools:', error)
      res.status(500).json({ success: false, error: 'Failed to get custom tools' })
    }
  })

  // GET /api/custom-tools/directory - Get custom tools directory path
  app.get('/api/custom-tools/directory', (_req, res) => {
    try {
      const directory = customToolRegistry.getCustomToolsDirectoryPath()
      res.json({ success: true, directory })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools directory:', error)
      res.status(500).json({ success: false, error: 'Failed to get directory' })
    }
  })

  // GET /api/custom-tools/settings - Get custom tools lifecycle settings
  app.get('/api/custom-tools/settings', (_req, res) => {
    try {
      res.json({ success: true, settings: customToolRegistry.getSettings() })
    } catch (error) {
      console.error('[LocalServer] Error getting custom tools settings:', error)
      res.status(500).json({ success: false, error: 'Failed to get custom tools settings' })
    }
  })

  // PUT /api/custom-tools/settings - Update custom tools lifecycle settings
  app.put('/api/custom-tools/settings', async (req, res) => {
    try {
      const updates = req.body || {}
      const settings = await customToolRegistry.updateSettings({
        autoRefresh: updates.autoRefresh,
        refreshDebounceMs: updates.refreshDebounceMs,
      })
      res.json({ success: true, settings })
    } catch (error) {
      console.error('[LocalServer] Error updating custom tools settings:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // PATCH /api/custom-tools/:name - Enable/disable a custom tool
  app.patch('/api/custom-tools/:name', async (req, res) => {
    try {
      const { enabled } = req.body || {}
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled boolean is required' })
        return
      }

      const updated = await customToolRegistry.setToolEnabled(req.params.name, enabled)
      if (!updated) {
        res.status(404).json({ success: false, error: `Custom tool "${req.params.name}" not found` })
        return
      }

      res.json({ success: true, tool: updated })
    } catch (error) {
      console.error('[LocalServer] Error updating custom tool enabled state:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/custom-tools/add - Add a custom tool directory into managed tools
  app.post('/api/custom-tools/add', async (req, res) => {
    try {
      const { sourcePath, directoryName, overwrite } = req.body || {}
      if (!sourcePath || typeof sourcePath !== 'string') {
        res.status(400).json({ success: false, error: 'sourcePath is required' })
        return
      }

      const added = await customToolRegistry.addToolFromDirectory(sourcePath, {
        directoryName: typeof directoryName === 'string' ? directoryName : undefined,
        overwrite: overwrite === true,
      })
      res.json({ success: true, ...added })
    } catch (error) {
      console.error('[LocalServer] Error adding custom tool:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // DELETE /api/custom-tools/:name - Remove custom tool by name or directory
  app.delete('/api/custom-tools/:name', async (req, res) => {
    try {
      const removed = await customToolRegistry.removeTool(req.params.name)
      res.json({ success: true, ...removed })
    } catch (error) {
      console.error('[LocalServer] Error removing custom tool:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(400).json({ success: false, error: msg })
    }
  })

  // POST /api/custom-tools/reload - Reload all custom tools from disk
  app.post('/api/custom-tools/reload', async (_req, res) => {
    try {
      await customToolRegistry.reload('api_reload')
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        tools: definitions,
        statuses: customToolRegistry.getStatuses(),
        settings: customToolRegistry.getSettings(),
        message: `Reloaded ${definitions.length} custom tools`,
      })
    } catch (error) {
      console.error('[LocalServer] Error reloading custom tools:', error)
      res.status(500).json({ success: false, error: 'Failed to reload custom tools' })
    }
  })

  // ============================================================================
  // App Store API Endpoints
  // ============================================================================

  // GET /api/app-store/community - Proxy community app list from remote server
  app.get('/api/app-store/community', async (_req, res) => {
    try {
      const response = await fetch(buildRemoteApiUrl('/app-store/community'))
      const data = await response.json()
      res.status(response.status).json(data)
    } catch (error) {
      console.error('[LocalServer] Failed to fetch community apps:', error)
      res.status(500).json({ success: false, error: 'Failed to fetch community apps' })
    }
  })

  // POST /api/app-store/community/upload - Proxy community upload to remote server
  app.post(
    '/api/app-store/community/upload',
    express.raw({ type: 'application/zip', limit: '500mb' }),
    async (req, res) => {
      try {
        if (!req.body || (req.body as Buffer).length === 0) {
          res.status(400).json({ success: false, error: 'Zip payload is required.' })
          return
        }

        const authHeader = req.headers.authorization
        if (!authHeader) {
          res.status(401).json({ success: false, error: 'Authorization header is required.' })
          return
        }

        const zipBuffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body)
        const filenameHeader = req.headers['x-app-store-filename']

        const response = await fetch(buildRemoteApiUrl('/app-store/community/upload'), {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/zip',
            ...(filenameHeader ? { 'x-app-store-filename': String(filenameHeader) } : {}),
          },
          body: zipBuffer,
        })

        const data = await response.json()
        res.status(response.status).json(data)
      } catch (error) {
        console.error('[LocalServer] Failed to upload community app:', error)
        res.status(500).json({ success: false, error: 'Failed to upload community app' })
      }
    }
  )

  // POST /api/app-store/validate-upload - Validate community app zip before upload
  app.post(
    '/api/app-store/validate-upload',
    express.raw({ type: 'application/zip', limit: '500mb' }),
    async (req, res) => {
      try {
        if (!req.body || (req.body as Buffer).length === 0) {
          res.status(400).json({ success: false, error: 'Zip payload is required.' })
          return
        }

        const zipBuffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body)

        const zip = new AdmZip(zipBuffer)
        const entries = zip.getEntries()

        if (!entries || entries.length === 0) {
          res.status(400).json({ success: false, error: 'Zip file is empty.' })
          return
        }

        if (entries.length > MAX_UPLOAD_ENTRIES) {
          res.status(400).json({ success: false, error: 'Zip file contains too many entries.' })
          return
        }

        const stripPrefix = detectZipStripPrefix(entries)
        const topLevel = new Set<string>()
        let totalUnpacked = 0
        let containsExecutables = false
        let hasRootFile = false
        const normalizedEntries: Array<{ entry: any; name: string }> = []

        for (const entry of entries) {
          let entryName = sanitizeZipEntryName(entry.entryName)
          if (stripPrefix && entryName.startsWith(stripPrefix)) {
            entryName = entryName.slice(stripPrefix.length)
          }
          if (!entryName) continue
          const lowerName = entryName.toLowerCase()
          if (lowerName.startsWith('__macosx/')) {
            continue
          }
          if (lowerName.endsWith('.ds_store') || lowerName.endsWith('thumbs.db')) {
            continue
          }
          if (entryName.split('/').some(part => part === '..')) {
            res.status(400).json({ success: false, error: 'Zip contains invalid path traversal entries.' })
            return
          }

          const isDirectory = entry.isDirectory || entryName.endsWith('/')
          if (!entryName.includes('/') && !isDirectory) {
            hasRootFile = true
          }

          const parts = entryName.split('/')
          if (parts[0]) topLevel.add(parts[0])

          if (!isDirectory) {
            totalUnpacked += entry.header.size
            const ext = path.extname(entryName).toLowerCase()
            if (EXECUTABLE_EXTENSIONS.has(ext)) {
              containsExecutables = true
            }
          }

          normalizedEntries.push({ entry, name: entryName })
        }

        if (totalUnpacked > MAX_UPLOAD_UNPACKED_BYTES) {
          res.status(400).json({ success: false, error: 'Zip file is too large when extracted.' })
          return
        }

        if (topLevel.size !== 1 || hasRootFile) {
          res.status(400).json({
            success: false,
            error: 'Zip must contain a single top-level folder that holds your tool files.',
          })
          return
        }

        const toolDir = Array.from(topLevel)[0]
        if (!toolDir || toolDir === '.' || toolDir === '..') {
          res.status(400).json({ success: false, error: 'Invalid tool directory name in zip.' })
          return
        }

        const definitionPath = `${toolDir}/definition.json`
        const descriptionPath = `${toolDir}/description.json`
        const indexPath = `${toolDir}/index.js`

        const definitionEntry = normalizedEntries.find(item => item.name === definitionPath)
        const descriptionEntry = normalizedEntries.find(item => item.name === descriptionPath)
        const indexEntry = normalizedEntries.find(item => item.name === indexPath)

        if (!definitionEntry || !descriptionEntry) {
          res.status(400).json({
            success: false,
            error: 'Zip must include definition.json and description.json in the tool folder root.',
          })
          return
        }

        if (!indexEntry) {
          res.status(400).json({ success: false, error: 'Zip must include index.js in the tool folder root.' })
          return
        }

        const extraDefinition = normalizedEntries.find(
          item => item.name.endsWith('/definition.json') && item.name !== definitionPath
        )
        if (extraDefinition) {
          res.status(400).json({ success: false, error: 'Zip must include only one definition.json file.' })
          return
        }

        const extraDescription = normalizedEntries.find(
          item => item.name.endsWith('/description.json') && item.name !== descriptionPath
        )
        if (extraDescription) {
          res.status(400).json({ success: false, error: 'Zip must include only one description.json file.' })
          return
        }

        const definitionRaw = definitionEntry.entry.getData().toString('utf-8')
        const descriptionRaw = descriptionEntry.entry.getData().toString('utf-8')

        let definitionJson: any
        let descriptionJson: any

        try {
          definitionJson = JSON.parse(definitionRaw)
        } catch {
          res.status(400).json({ success: false, error: 'definition.json must be valid JSON.' })
          return
        }

        try {
          descriptionJson = JSON.parse(descriptionRaw)
        } catch {
          res.status(400).json({ success: false, error: 'description.json must be valid JSON.' })
          return
        }

        const definitionError = validateToolDefinition(definitionJson)
        if (definitionError) {
          res.status(400).json({ success: false, error: definitionError })
          return
        }

        const descriptionError = validateDescription(descriptionJson)
        if (descriptionError) {
          res.status(400).json({ success: false, error: descriptionError })
          return
        }

        const warnings: string[] = []
        if (definitionJson.name !== toolDir && definitionJson.name !== toolDir.replace(/-/g, '_')) {
          warnings.push('Tool folder name does not match definition.json name.')
        }

        res.json({
          success: true,
          appId: definitionJson.name,
          toolDir,
          description: descriptionJson,
          definition: definitionJson,
          containsExecutables,
          warnings,
        })
      } catch (error) {
        console.error('[LocalServer] App store upload validation error:', error)
        const msg = error instanceof Error ? error.message : String(error)
        res.status(500).json({ success: false, error: msg })
      }
    }
  )

  // POST /api/app-store/install - Download and install/update an app package into custom tools
  app.post('/api/app-store/install', async (req, res) => {
    let tempDirToCleanup: string | null = null

    try {
      const { zipUrl, appId, appName, mode } = req.body || {}
      const requestedMode = mode === 'update' ? 'update' : 'install'

      if (!zipUrl || typeof zipUrl !== 'string') {
        res.status(400).json({ success: false, error: 'zipUrl is required' })
        return
      }

      const response = await fetch(zipUrl)
      if (!response.ok) {
        res.status(400).json({
          success: false,
          error: `Failed to download app package (${response.status} ${response.statusText})`,
        })
        return
      }

      const arrayBuffer = await response.arrayBuffer()
      const zipBuffer = Buffer.from(arrayBuffer)
      const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()

      await fs.promises.mkdir(customToolsDir, { recursive: true })

      let extracted = 0
      let skipped = 0
      let strippedPrefix: string | null | undefined = null
      let preservedResources = 0
      let effectiveMode: 'install' | 'update' = requestedMode

      if (requestedMode === 'update') {
        if (!appId || typeof appId !== 'string') {
          res.status(400).json({ success: false, error: 'appId is required for update mode' })
          return
        }

        if (appId.includes('/') || appId.includes('\\')) {
          res.status(400).json({ success: false, error: 'Invalid appId' })
          return
        }

        const staged = await stageZipBufferForToolInstall(zipBuffer)
        tempDirToCleanup = staged.tempDir
        extracted = staged.extracted
        skipped = staged.skipped
        strippedPrefix = staged.strippedPrefix

        const targetToolPath = validateAndResolvePath(appId, customToolsDir, false)
        const targetStats = await fs.promises.stat(targetToolPath).catch(() => null)
        if (!targetStats || !targetStats.isDirectory()) {
          res.status(404).json({ success: false, error: `Installed app directory not found for "${appId}"` })
          return
        }

        const deployed = await deployToolUpdateWithPreservedResources({
          stagedToolPath: staged.stagedToolPath,
          targetToolPath,
          preserveDirs: DEFAULT_PRESERVE_RESOURCE_DIRS,
        })
        preservedResources = deployed.preservedResources
      } else {
        const staged = await stageZipBufferForToolInstall(zipBuffer)
        tempDirToCleanup = staged.tempDir
        extracted = staged.extracted
        skipped = staged.skipped
        strippedPrefix = staged.strippedPrefix

        const targetToolPath = validateAndResolvePath(staged.stagedToolDirName, customToolsDir, false)
        const targetExists = await pathExists(targetToolPath)

        if (targetExists) {
          effectiveMode = 'update'
          const targetStats = await fs.promises.stat(targetToolPath)
          if (!targetStats.isDirectory()) {
            res.status(400).json({ success: false, error: 'Existing app path is not a directory' })
            return
          }

          const deployed = await deployToolUpdateWithPreservedResources({
            stagedToolPath: staged.stagedToolPath,
            targetToolPath,
            preserveDirs: DEFAULT_PRESERVE_RESOURCE_DIRS,
          })
          preservedResources = deployed.preservedResources
        } else {
          await fs.promises.cp(staged.stagedToolPath, targetToolPath, {
            recursive: true,
            force: true,
            errorOnExist: false,
          })
        }
      }

      await customToolRegistry.reload(`app_store_${effectiveMode}`)
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        appId,
        appName,
        mode: effectiveMode,
        extracted,
        skipped,
        strippedPrefix,
        preservedResources,
        toolCount: definitions.length,
        restartRequired: false,
        message:
          effectiveMode === 'update'
            ? `App updated and loaded. Preserved ${preservedResources} resource folder${preservedResources === 1 ? '' : 's'}.`
            : 'App installed and loaded.',
      })
    } catch (error) {
      console.error('[LocalServer] App store install error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    } finally {
      if (tempDirToCleanup) {
        await fs.promises.rm(tempDirToCleanup, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  })

  // POST /api/app-store/uninstall - Remove an app package from custom tools
  app.post('/api/app-store/uninstall', async (req, res) => {
    try {
      const { appId } = req.body || {}

      if (!appId || typeof appId !== 'string') {
        res.status(400).json({ success: false, error: 'appId is required' })
        return
      }

      if (appId.includes('/') || appId.includes('\\')) {
        res.status(400).json({ success: false, error: 'Invalid appId' })
        return
      }

      const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()
      const targetPath = validateAndResolvePath(appId, customToolsDir, false)

      let stats: fs.Stats | null = null
      try {
        stats = await fs.promises.stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ success: false, error: 'App not installed' })
          return
        }
        throw error
      }

      if (!stats?.isDirectory()) {
        res.status(400).json({ success: false, error: 'App path is not a directory' })
        return
      }

      await fs.promises.rm(targetPath, { recursive: true, force: true })

      await customToolRegistry.reload('app_store_uninstall')
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        appId,
        toolCount: definitions.length,
        restartRequired: false,
        message: 'App uninstalled.',
      })
    } catch (error) {
      console.error('[LocalServer] App store uninstall error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/app/restart - Relaunch the Electron app
  app.post('/api/app/restart', (_req, res) => {
    try {
      res.json({ success: true, message: 'Restarting app' })
      setTimeout(() => {
        try {
          electronApp.relaunch()
          electronApp.exit(0)
        } catch (error) {
          console.error('[LocalServer] Failed to restart app:', error)
        }
      }, 300)
    } catch (error) {
      console.error('[LocalServer] Restart request failed:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // ============================================================================
  // Tool Orchestrator / Job Management API
  // ============================================================================

  // POST /api/jobs - Submit a new background job
  app.post('/api/jobs', async (req, res) => {
    try {
      const { toolName, args, options } = req.body as {
        toolName: string
        args: Record<string, any>
        options?: JobOptions
      }

      if (!toolName) {
        res.status(400).json({ success: false, error: 'toolName is required' })
        return
      }

      const job = toolOrchestrator.submit(toolName, args || {}, options || {})
      res.json({ success: true, job })
    } catch (error) {
      console.error('[LocalServer] Error submitting job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs - List jobs with optional filters
  app.get('/api/jobs', (req, res) => {
    try {
      const filter: JobFilter = {}

      // Parse query parameters
      if (req.query.status) {
        const statuses = (req.query.status as string).split(',')
        filter.status = statuses.length === 1 ? (statuses[0] as any) : (statuses as any)
      }
      if (req.query.conversationId) {
        filter.conversationId = req.query.conversationId as string
      }
      if (req.query.toolName) {
        filter.toolName = req.query.toolName as string
      }
      if (req.query.limit) {
        filter.limit = parseInt(req.query.limit as string, 10)
      }
      if (req.query.offset) {
        filter.offset = parseInt(req.query.offset as string, 10)
      }
      if (req.query.orderBy) {
        filter.orderBy = req.query.orderBy as any
      }
      if (req.query.orderDir) {
        filter.orderDir = req.query.orderDir as any
      }

      const jobs = toolOrchestrator.listJobs(filter)
      res.json({ success: true, jobs })
    } catch (error) {
      console.error('[LocalServer] Error listing jobs:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs/stats - Get orchestrator statistics
  app.get('/api/jobs/stats', (_req, res) => {
    try {
      const stats = toolOrchestrator.getStats()
      res.json({ success: true, stats })
    } catch (error) {
      console.error('[LocalServer] Error getting job stats:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // GET /api/jobs/:id - Get a specific job
  app.get('/api/jobs/:id', (req, res) => {
    try {
      const job = toolOrchestrator.getJob(req.params.id)
      if (job) {
        res.json({ success: true, job })
      } else {
        res.status(404).json({ success: false, error: 'Job not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/jobs/:id/cancel - Cancel a job
  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      const cancelled = toolOrchestrator.cancel(req.params.id)
      if (cancelled) {
        res.json({ success: true, message: 'Job cancelled' })
      } else {
        res.status(400).json({ success: false, error: 'Job could not be cancelled (already completed or not found)' })
      }
    } catch (error) {
      console.error('[LocalServer] Error cancelling job:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/jobs/execute-and-wait - Submit job and wait for completion
  // This is useful for stream integration where you want background execution
  // but still need to wait for the result before continuing
  app.post('/api/jobs/execute-and-wait', async (req, res) => {
    try {
      const {
        toolName,
        args,
        options,
        timeoutMs = 300000,
      } = req.body as {
        toolName: string
        args: Record<string, any>
        options?: JobOptions
        timeoutMs?: number
      }

      if (!toolName) {
        res.status(400).json({ success: false, error: 'toolName is required' })
        return
      }

      // Submit the job
      const job = toolOrchestrator.submit(toolName, args || {}, {
        ...options,
        timeoutMs: Math.min(timeoutMs, 600000), // Max 10 minutes
      })

      // Poll for completion
      const pollInterval = 100 // ms
      const startTime = Date.now()

      while (Date.now() - startTime < timeoutMs) {
        const currentJob = toolOrchestrator.getJob(job.id)

        if (!currentJob) {
          res.status(500).json({ success: false, error: 'Job disappeared unexpectedly' })
          return
        }

        if (currentJob.status === 'completed') {
          res.json({ success: true, job: currentJob, result: currentJob.result })
          return
        }

        if (currentJob.status === 'failed') {
          res.json({ success: false, job: currentJob, error: currentJob.error })
          return
        }

        if (currentJob.status === 'cancelled') {
          res.json({ success: false, job: currentJob, error: 'Job was cancelled' })
          return
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval))
      }

      // Timeout - cancel the job
      toolOrchestrator.cancel(job.id)
      res.status(408).json({ success: false, error: 'Job execution timed out', jobId: job.id })
    } catch (error) {
      console.error('[LocalServer] Error in execute-and-wait:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // [Phase 1] App automation routes moved to electron/headlessServer/routes/appAutomationRoutes.ts.

  // Stats endpoint
  app.get('/api/sync/stats', (_req, res) => {
    try {
      const stats = {
        projects: db!.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number },
        conversations: db!.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number },
        messages: db!.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number },
        attachments: db!.prepare('SELECT COUNT(*) as count FROM message_attachments').get() as { count: number },
      }
      res.json(stats)
    } catch (error) {
      console.error('[LocalServer] Error getting stats:', error)
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  // Local analytics dashboard endpoint
  app.get('/api/local/analytics/dashboard', (req, res) => {
    try {
      const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
      const round = (value: number, digits = 6) => {
        const factor = 10 ** digits
        return Math.round(value * factor) / factor
      }
      const toNumber = (value: unknown) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string') {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : 0
        }
        return 0
      }
      const parseTimestamp = (value: unknown) => {
        if (typeof value !== 'string' || value.trim().length === 0) return null
        const ms = Date.parse(value)
        return Number.isNaN(ms) ? null : ms
      }
      const dayKey = (value: unknown) => {
        const ms = parseTimestamp(value)
        if (ms === null) return 'unknown'
        return new Date(ms).toISOString().slice(0, 10)
      }
      const parseToolCalls = (input: unknown): any[] => {
        if (Array.isArray(input)) return input
        if (input && typeof input === 'object') return [input]
        if (typeof input === 'string') {
          try {
            return parseToolCalls(JSON.parse(input))
          } catch {
            return []
          }
        }
        return []
      }
      const extractToolName = (toolCall: unknown): string | null => {
        if (!toolCall || typeof toolCall !== 'object') return null
        const record = toolCall as Record<string, unknown>
        const direct = typeof record.name === 'string' ? record.name : null
        const functionName =
          record.function && typeof record.function === 'object'
            ? typeof (record.function as Record<string, unknown>).name === 'string'
              ? ((record.function as Record<string, unknown>).name as string)
              : null
            : null
        const name = direct || functionName
        return name && name.trim() ? name.trim() : null
      }

      const rangeDaysParam = Number(req.query.rangeDays)
      const rangeDays = Number.isFinite(rangeDaysParam) ? clamp(Math.trunc(rangeDaysParam), 1, 365) : 30
      const projectId =
        typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : null
      const conversationId =
        typeof req.query.conversationId === 'string' && req.query.conversationId.trim()
          ? req.query.conversationId.trim()
          : null
      const modelFilter = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : null
      const toolNameFilter =
        typeof req.query.toolName === 'string' && req.query.toolName.trim() ? req.query.toolName.trim() : null
      const toolStatusFilter =
        typeof req.query.toolStatus === 'string' && req.query.toolStatus.trim() ? req.query.toolStatus.trim() : null

      const sinceMs = Date.now() - rangeDays * 24 * 60 * 60 * 1000

      const projects = db!
        .prepare('SELECT id, name, created_at, storage_mode FROM projects ORDER BY created_at ASC')
        .all() as Array<{ id: string; name: string; created_at: string; storage_mode: 'cloud' | 'local' | null }>

      const conversations = db!
        .prepare('SELECT id, project_id, title, created_at, storage_mode FROM conversations ORDER BY created_at ASC')
        .all() as Array<{
        id: string
        project_id: string | null
        title: string | null
        created_at: string
        storage_mode: 'cloud' | 'local' | null
      }>

      const messages = db!
        .prepare(
          'SELECT id, conversation_id, parent_id, role, model_name, tool_calls, content, plain_text_content, content_blocks, created_at FROM messages ORDER BY created_at ASC'
        )
        .all() as Array<{
        id: string
        conversation_id: string
        parent_id: string | null
        role: string
        model_name: string | null
        tool_calls: string | null
        content: string
        plain_text_content: string | null
        content_blocks: string | null
        created_at: string
      }>

      const providerCosts = db!
        .prepare(
          `SELECT 
             pc.id,
             pc.message_id,
             pc.prompt_tokens,
             pc.completion_tokens,
             pc.reasoning_tokens,
             pc.approx_cost,
             pc.api_credit_cost,
             pc.created_at,
             m.conversation_id,
             m.model_name
           FROM provider_cost pc
           LEFT JOIN messages m ON m.id = pc.message_id
           ORDER BY pc.created_at ASC`
        )
        .all() as Array<{
        id: string
        message_id: string
        prompt_tokens: number
        completion_tokens: number
        reasoning_tokens: number
        approx_cost: number
        api_credit_cost: number
        created_at: string
        conversation_id: string | null
        model_name: string | null
      }>

      let toolJobs: Array<{
        id: string
        tool_name: string
        status: string
        conversation_id: string | null
        created_at: string
        started_at: string | null
        completed_at: string | null
        error: string | null
      }> = []

      try {
        toolJobs = db!
          .prepare(
            'SELECT id, tool_name, status, conversation_id, created_at, started_at, completed_at, error FROM tool_jobs ORDER BY created_at ASC'
          )
          .all() as typeof toolJobs
      } catch {
        toolJobs = []
      }

      const scopedProjects = projects.filter(project => {
        if (projectId && project.id !== projectId) return false
        const created = parseTimestamp(project.created_at)
        return created === null ? false : created >= sinceMs
      })

      const scopedConversations = conversations.filter(conversation => {
        if (projectId && conversation.project_id !== projectId) return false
        if (conversationId && conversation.id !== conversationId) return false
        const created = parseTimestamp(conversation.created_at)
        return created === null ? false : created >= sinceMs
      })
      const scopedConversationIdSet = new Set(scopedConversations.map(conversation => conversation.id))

      const scopedMessages = messages.filter(message => {
        if (!scopedConversationIdSet.has(message.conversation_id)) return false
        const created = parseTimestamp(message.created_at)
        return created === null ? false : created >= sinceMs
      })

      const filteredMessages = scopedMessages.filter(message => {
        if (!modelFilter) return true
        return message.model_name === modelFilter
      })

      const scopedProviderCosts = providerCosts.filter(cost => {
        const created = parseTimestamp(cost.created_at)
        if (created === null || created < sinceMs) return false
        if (conversationId && cost.conversation_id !== conversationId) return false
        if (projectId && cost.conversation_id) {
          return scopedConversationIdSet.has(cost.conversation_id)
        }
        if (projectId && !cost.conversation_id) return false
        return true
      })

      const filteredProviderCosts = scopedProviderCosts.filter(cost => {
        if (!modelFilter) return true
        return (cost.model_name || 'unknown') === modelFilter
      })

      const requestedToolCalls = filteredMessages.flatMap(message =>
        parseToolCalls(message.tool_calls)
          .map(call => extractToolName(call))
          .filter((name): name is string => Boolean(name))
      )

      const filteredRequestedToolCalls = toolNameFilter
        ? requestedToolCalls.filter(toolName => toolName === toolNameFilter)
        : requestedToolCalls

      const scopedToolJobs = toolJobs.filter(job => {
        const created = parseTimestamp(job.created_at)
        if (created === null || created < sinceMs) return false
        if (conversationId && job.conversation_id !== conversationId) return false
        if (projectId && job.conversation_id && !scopedConversationIdSet.has(job.conversation_id)) return false
        if (projectId && !job.conversation_id) return false
        if (toolNameFilter && job.tool_name !== toolNameFilter) return false
        if (toolStatusFilter && job.status !== toolStatusFilter) return false
        return true
      })

      const messageById = new Map(filteredMessages.map(message => [message.id, message]))
      const messageCostIdSet = new Set(filteredProviderCosts.map(cost => cost.message_id))

      const messageCountByRole = filteredMessages.reduce<Record<string, number>>((acc, message) => {
        acc[message.role] = (acc[message.role] || 0) + 1
        return acc
      }, {})

      const messagesPerDay = filteredMessages.reduce<Record<string, number>>((acc, message) => {
        const key = dayKey(message.created_at)
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {})

      const childrenCountByParent = new Map<string, number>()
      for (const message of filteredMessages) {
        if (!message.parent_id) continue
        childrenCountByParent.set(message.parent_id, (childrenCountByParent.get(message.parent_id) || 0) + 1)
      }
      const branchPoints = Array.from(childrenCountByParent.values()).filter(count => count > 1).length

      const depthMemo = new Map<string, number>()
      const visiting = new Set<string>()
      const computeDepth = (id: string): number => {
        if (depthMemo.has(id)) return depthMemo.get(id) || 0
        if (visiting.has(id)) return 0
        visiting.add(id)
        const current = messageById.get(id)
        let depth = 0
        if (current?.parent_id && messageById.has(current.parent_id)) {
          depth = computeDepth(current.parent_id) + 1
        }
        visiting.delete(id)
        depthMemo.set(id, depth)
        return depth
      }

      const messageDepths = filteredMessages.map(message => computeDepth(message.id))
      const maxDepth = messageDepths.length > 0 ? Math.max(...messageDepths) : 0
      const avgDepth =
        messageDepths.length > 0 ? messageDepths.reduce((sum, depth) => sum + depth, 0) / messageDepths.length : 0

      const totalApproxCost = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.approx_cost), 0)
      const totalApiCredits = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.api_credit_cost), 0)
      const totalPromptTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.prompt_tokens), 0)
      const totalCompletionTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.completion_tokens), 0)
      const totalReasoningTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.reasoning_tokens), 0)
      const totalCharacters = filteredMessages.reduce((sum, message) => {
        let messageText = message.plain_text_content || message.content || ''

        if (message.content_blocks) {
          try {
            const blocks = JSON.parse(message.content_blocks)
            if (Array.isArray(blocks)) {
              const blocksText = blocks
                .map((block: any) => {
                  if (!block || typeof block !== 'object') return ''
                  if (block.type === 'text') return block.text || block.content || ''
                  if (block.type === 'thinking') return block.thinking || block.content || ''
                  if (block.type === 'tool_use') {
                    const toolInput = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                    return `${block.name || 'tool'} ${toolInput}`
                  }
                  if (block.type === 'tool_result') return block.content || ''
                  return block.content || block.text || block.thinking || ''
                })
                .join('\n')

              if (blocksText) {
                messageText = `${messageText}\n${blocksText}`.trim()
              }
            }
          } catch {
            // ignore malformed content_blocks
          }
        }

        return sum + messageText.length
      }, 0)
      const estimatedTotalTokens = totalCharacters * 4

      const assistantMessageCount = filteredMessages.filter(message => message.role === 'assistant').length
      const assistantWithCost = filteredMessages.filter(
        message => message.role === 'assistant' && messageCostIdSet.has(message.id)
      ).length

      const dailyCostMap = new Map<
        string,
        {
          date: string
          approxCost: number
          apiCredits: number
          promptTokens: number
          completionTokens: number
          reasoningTokens: number
        }
      >()

      for (const row of filteredProviderCosts) {
        const key = dayKey(row.created_at)
        const existing = dailyCostMap.get(key) || {
          date: key,
          approxCost: 0,
          apiCredits: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
        }
        existing.approxCost += toNumber(row.approx_cost)
        existing.apiCredits += toNumber(row.api_credit_cost)
        existing.promptTokens += toNumber(row.prompt_tokens)
        existing.completionTokens += toNumber(row.completion_tokens)
        existing.reasoningTokens += toNumber(row.reasoning_tokens)
        dailyCostMap.set(key, existing)
      }

      const dailySpend = Array.from(dailyCostMap.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({
          ...row,
          approxCost: round(row.approxCost),
          apiCredits: round(row.apiCredits),
        }))

      const modelStatsMap = new Map<
        string,
        { runs: number; totalApproxCost: number; totalApiCredits: number; tokens: number }
      >()
      for (const row of filteredProviderCosts) {
        const model = row.model_name || 'unknown'
        const existing = modelStatsMap.get(model) || { runs: 0, totalApproxCost: 0, totalApiCredits: 0, tokens: 0 }
        existing.runs += 1
        existing.totalApproxCost += toNumber(row.approx_cost)
        existing.totalApiCredits += toNumber(row.api_credit_cost)
        existing.tokens +=
          toNumber(row.prompt_tokens) + toNumber(row.completion_tokens) + toNumber(row.reasoning_tokens)
        modelStatsMap.set(model, existing)
      }

      const topModels = Array.from(modelStatsMap.entries())
        .map(([model, stat]) => ({
          model,
          runs: stat.runs,
          totalApproxCost: round(stat.totalApproxCost),
          totalActualCredits: round(stat.totalApiCredits),
          avgActualCredits: round(stat.totalApiCredits / Math.max(1, stat.runs)),
          totalTokens: Math.round(stat.tokens),
        }))
        .sort((a, b) => b.totalActualCredits - a.totalActualCredits)

      const toolRequestedByName = filteredRequestedToolCalls.reduce<Record<string, number>>((acc, toolName) => {
        acc[toolName] = (acc[toolName] || 0) + 1
        return acc
      }, {})

      const requestedToolsDailyMap = filteredMessages.reduce<Record<string, Record<string, number>>>((acc, message) => {
        const key = dayKey(message.created_at)
        const toolNames = parseToolCalls(message.tool_calls)
          .map(call => extractToolName(call))
          .filter((name): name is string => Boolean(name))
        if (!acc[key]) acc[key] = {}
        for (const toolName of toolNames) {
          acc[key][toolName] = (acc[key][toolName] || 0) + 1
        }
        return acc
      }, {})

      const toolStatusCounts = scopedToolJobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.status] = (acc[job.status] || 0) + 1
        return acc
      }, {})

      const failedByTool = scopedToolJobs
        .filter(job => job.status === 'failed')
        .reduce<Record<string, number>>((acc, job) => {
          acc[job.tool_name] = (acc[job.tool_name] || 0) + 1
          return acc
        }, {})

      const topFailing = Object.entries(failedByTool)
        .map(([toolName, failures]) => ({ toolName, failures }))
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 10)

      const durationValues = scopedToolJobs
        .map(job => {
          const started = parseTimestamp(job.started_at)
          const completed = parseTimestamp(job.completed_at)
          if (started === null || completed === null || completed < started) return null
          return completed - started
        })
        .filter((value): value is number => value !== null)

      const toolJobStatsMap = new Map<
        string,
        {
          toolName: string
          requested: number
          total: number
          completed: number
          failed: number
          cancelled: number
          pending: number
          running: number
          durations: number[]
        }
      >()

      const ensureToolJobStat = (toolName: string) => {
        const existing = toolJobStatsMap.get(toolName)
        if (existing) return existing
        const created = {
          toolName,
          requested: toolRequestedByName[toolName] || 0,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          pending: 0,
          running: 0,
          durations: [] as number[],
        }
        toolJobStatsMap.set(toolName, created)
        return created
      }

      for (const toolName of Object.keys(toolRequestedByName)) {
        ensureToolJobStat(toolName)
      }

      const toolJobsDailyMap = new Map<
        string,
        { date: string; requested: number; total: number; completed: number; failed: number; cancelled: number }
      >()

      for (const [date, requestedCounts] of Object.entries(requestedToolsDailyMap)) {
        const requested = Object.values(requestedCounts).reduce((sum, count) => sum + count, 0)
        toolJobsDailyMap.set(date, {
          date,
          requested,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        })
      }

      for (const job of scopedToolJobs) {
        const stat = ensureToolJobStat(job.tool_name)
        stat.total += 1
        if (job.status === 'completed') stat.completed += 1
        else if (job.status === 'failed') stat.failed += 1
        else if (job.status === 'cancelled') stat.cancelled += 1
        else if (job.status === 'pending') stat.pending += 1
        else if (job.status === 'running') stat.running += 1

        const started = parseTimestamp(job.started_at)
        const completed = parseTimestamp(job.completed_at)
        if (started !== null && completed !== null && completed >= started) {
          stat.durations.push(completed - started)
        }

        const date = dayKey(job.created_at)
        const daily = toolJobsDailyMap.get(date) || {
          date,
          requested: 0,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        }
        daily.total += 1
        if (job.status === 'completed') daily.completed += 1
        else if (job.status === 'failed') daily.failed += 1
        else if (job.status === 'cancelled') daily.cancelled += 1
        toolJobsDailyMap.set(date, daily)
      }

      const toolJobsByTool = Array.from(toolJobStatsMap.values())
        .map(stat => {
          const terminalTotal = stat.completed + stat.failed + stat.cancelled
          const averageDurationMs =
            stat.durations.length > 0 ? round(stat.durations.reduce((sum, value) => sum + value, 0) / stat.durations.length, 2) : null
          const failureRatePct = terminalTotal > 0 ? round((stat.failed / terminalTotal) * 100, 2) : 0

          return {
            toolName: stat.toolName,
            requested: stat.requested,
            total: stat.total,
            completed: stat.completed,
            failed: stat.failed,
            cancelled: stat.cancelled,
            pending: stat.pending,
            running: stat.running,
            averageDurationMs,
            failureRatePct,
          }
        })
        .sort((a, b) => {
          if (b.total !== a.total) return b.total - a.total
          if (b.requested !== a.requested) return b.requested - a.requested
          return a.toolName.localeCompare(b.toolName)
        })

      const toolJobsDaily = Array.from(toolJobsDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))

      const availableModels = Array.from(
        new Set([
          ...scopedProviderCosts.map(cost => cost.model_name || 'unknown'),
          ...scopedMessages.map(message => message.model_name || 'unknown'),
        ])
      ).sort()

      const availableToolNames = Array.from(
        new Set(
          scopedMessages.flatMap(message =>
            parseToolCalls(message.tool_calls)
              .map(call => extractToolName(call))
              .filter((name): name is string => Boolean(name))
          )
        )
      ).sort()

      const burnRatePerDay = totalApiCredits / Math.max(1, rangeDays)

      res.json({
        rangeDays,
        source: 'local',
        filters: {
          applied: {
            projectId,
            conversationId,
            model: modelFilter,
            providerRunStatus: null,
            toolName: toolNameFilter,
            toolStatus: toolStatusFilter,
          },
          available: {
            models: availableModels,
            providerRunStatuses: [],
            toolNames: availableToolNames,
            toolJobStatuses: Array.from(new Set(toolJobs.map(job => job.status))).sort(),
            projects: scopedProjects.map(project => ({
              id: project.id,
              name: project.name,
              storage_mode: project.storage_mode,
            })),
            conversations: scopedConversations.map(conversation => ({
              id: conversation.id,
              title: conversation.title,
              project_id: conversation.project_id,
              storage_mode: conversation.storage_mode,
            })),
          },
        },
        summary: {
          netCreditsConsumed: round(totalApiCredits),
          totalReservedCredits: 0,
          totalRefundCredits: 0,
          totalAdjustmentCredits: 0,
          averageCreditsPerGeneration: round(totalApiCredits / Math.max(1, filteredProviderCosts.length)),
          averageCreditsPerAssistantMessage: round(totalApiCredits / Math.max(1, assistantMessageCount)),
          messagesTotal: filteredMessages.length,
          conversationsCreated: scopedConversations.length,
          projectsCreated: scopedProjects.length,
          activeDays: Object.keys(messagesPerDay).length,
          estimatedTotalTokens,
        },
        spend: {
          totals: {
            approxCostUsd: round(totalApproxCost),
            apiCredits: round(totalApiCredits),
            promptTokens: Math.round(totalPromptTokens),
            completionTokens: Math.round(totalCompletionTokens),
            reasoningTokens: Math.round(totalReasoningTokens),
          },
          daily: dailySpend,
          balanceTrend: [],
          burnRate: {
            creditsPerDay: round(burnRatePerDay),
            projectedDaysRemaining: null,
          },
        },
        models: {
          topByCredits: topModels,
          tokenMixByModel: topModels.map(model => ({
            model: model.model,
            prompt: model.totalTokens,
            completion: 0,
            reasoning: 0,
            samples: model.runs,
          })),
        },
        providerRuns: {
          statusCounts: {},
          quality: {
            total: 0,
            withGenerationIdPct: 0,
            withMessageLinkPct: 0,
            withConversationLinkPct: 0,
            reconciledPct: 0,
            lastReconciledAt: null,
          },
          reconcileLagMinutes: {
            avg: 0,
            p50: 0,
            p90: 0,
            max: 0,
          },
        },
        activity: {
          messagesByRole: messageCountByRole,
          messagesPerDay: Object.entries(messagesPerDay)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date)),
          branching: {
            branchPoints,
            averageDepth: round(avgDepth, 2),
            maxDepth,
          },
        },
        tools: {
          requested: {
            total: filteredRequestedToolCalls.length,
            byName: toolRequestedByName,
          },
          jobs: {
            available: true,
            statusCounts: toolStatusCounts,
            total: scopedToolJobs.length,
            topFailing,
            averageDurationMs:
              durationValues.length > 0
                ? round(durationValues.reduce((sum, duration) => sum + duration, 0) / durationValues.length, 2)
                : null,
            byTool: toolJobsByTool,
            daily: toolJobsDaily,
          },
        },
        payments: {
          currentPlan: null,
          history: {
            monthlyAllocation: [],
            topups: [],
          },
          currentCreditsBalance: null,
        },
        dataQuality: {
          assistantMessagesWithCostPct:
            assistantMessageCount > 0 ? round((assistantWithCost / assistantMessageCount) * 100, 2) : 0,
          assistantMessagesTotal: assistantMessageCount,
          assistantMessagesWithCost: assistantWithCost,
        },
      })
    } catch (error) {
      console.error('[LocalServer] Error getting local analytics dashboard:', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: 'Failed to get local analytics dashboard', message })
    }
  })

  // Update conversation research note
  app.patch('/api/conversations/:id/research-note', (req, res) => {
    try {
      const { id } = req.params
      const { researchNote } = req.body

      const normalizedResearchNote =
        typeof researchNote === 'string' && researchNote.trim().length === 0 ? null : (researchNote as string | null)

      statements.updateConversationResearchNote.run(normalizedResearchNote, id)
      const updated = statements.getConversationById.get(id)

      if (updated) {
        res.json(updated)
      } else {
        res.status(404).json({ error: 'Conversation not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error updating research note:', error)
      res.status(500).json({ error: 'Failed to update research note' })
    }
  })

  // Update conversation cwd
  app.patch('/api/conversations/:id/cwd', (req, res) => {
    try {
      const { id } = req.params
      const { cwd } = req.body

      const normalizedCwd = typeof cwd === 'string' && cwd.trim().length === 0 ? null : (cwd as string | null)

      statements.updateConversationCwd.run(normalizedCwd, id)
      const updated = statements.getConversationById.get(id)

      if (updated) {
        res.json(updated)
      } else {
        res.status(404).json({ error: 'Conversation not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error updating cwd:', error)
      res.status(500).json({ error: 'Failed to update cwd' })
    }
  })

  // Update conversation project
  app.patch('/api/conversations/:id/project', (req, res) => {
    try {
      const { id } = req.params
      const { projectId } = req.body

      // Require projectId to be explicitly provided (can be null to unassign, but must be present)
      if (!('projectId' in req.body)) {
        res.status(400).json({ error: 'projectId is required in request body' })
        return
      }

      // projectId can be null (unassign from project) or a valid project UUID string
      if (projectId !== null && typeof projectId !== 'string') {
        res.status(400).json({ error: 'projectId must be a string or null' })
        return
      }

      const existing = statements.getConversationById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // If projectId is provided (not null), verify the project exists
      if (projectId !== null) {
        const project = statements.getProjectById.get(projectId)
        if (!project) {
          res.status(404).json({ error: 'Destination project not found' })
          return
        }
      }

      statements.updateConversationProjectId.run(projectId, id)
      const updated = statements.getConversationById.get(id)

      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating project:', error)
      res.status(500).json({ error: 'Failed to update project' })
    }
  })

  // List local users available for manual ownership migration
  app.get('/api/local/users', (_req, res) => {
    try {
      const users = db!
        .prepare(
          `SELECT
             u.id,
             u.username,
             u.created_at,
             (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
             (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count,
             (SELECT COUNT(*) FROM provider_cost pc WHERE pc.user_id = u.id) AS provider_cost_count
           FROM users u
           ORDER BY conversation_count DESC, project_count DESC, created_at DESC`
        )
        .all()

      res.json(users)
    } catch (error) {
      console.error('[LocalServer] Error listing local users:', error)
      res.status(500).json({ error: 'Failed to list local users' })
    }
  })

  // Merge local-only user data into a cloud-authenticated user account
  app.post('/api/local/users/merge', (req, res) => {
    try {
      const { fromUserId, toUserId, toUsername, toCreatedAt } = req.body as {
        fromUserId?: string
        toUserId?: string
        toUsername?: string
        toCreatedAt?: string
      }

      if (!fromUserId || !toUserId) {
        res.status(400).json({ error: 'fromUserId and toUserId are required' })
        return
      }

      if (fromUserId === toUserId) {
        res.json({ success: true, merged: false, message: 'Source and target user are the same' })
        return
      }

      // Strict safety rule: only allow migration when there are NO existing non-default users.
      // If any cloud user already exists locally, do not re-parent default-local data.
      const existingNonDefaultUsers = db!
        .prepare('SELECT COUNT(*) as count FROM users WHERE id != ?')
        .get(fromUserId) as { count: number }

      if ((existingNonDefaultUsers?.count || 0) > 0) {
        res.json({
          success: true,
          merged: false,
          reason: 'existing_cloud_user_present',
          message: 'Migration skipped because a non-default user already exists locally',
        })
        return
      }

      const mergeTx = db!.transaction(() => {
        const toUserExists = db!.prepare('SELECT id FROM users WHERE id = ?').get(toUserId)
        if (!toUserExists) {
          db!
            .prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)')
            .run(toUserId, toUsername || 'user', toCreatedAt || new Date().toISOString())
        }

        const projectsResult = db!
          .prepare('UPDATE projects SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)
        const conversationsResult = db!
          .prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)
        const providerCostResult = db!
          .prepare('UPDATE provider_cost SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)

        const remainingRefs = db!
          .prepare(
            `SELECT (
              (SELECT COUNT(*) FROM projects WHERE user_id = ?) +
              (SELECT COUNT(*) FROM conversations WHERE user_id = ?) +
              (SELECT COUNT(*) FROM provider_cost WHERE user_id = ?)
            ) as total`
          )
          .get(fromUserId, fromUserId, fromUserId) as { total: number }

        if ((remainingRefs?.total || 0) === 0) {
          db!.prepare('DELETE FROM users WHERE id = ?').run(fromUserId)
        }

        return {
          projects: projectsResult.changes,
          conversations: conversationsResult.changes,
          providerCosts: providerCostResult.changes,
        }
      })()

      res.json({ success: true, merged: true, ...mergeTx })
    } catch (error) {
      console.error('[LocalServer] Error merging local user data:', error)
      res.status(500).json({ error: 'Failed to merge local user data' })
    }
  })

  // Local-only API endpoints
  app.get('/api/local/projects', (req, res) => {
    try {
      const userId = (req.query.userId as string) || ''
      if (!userId) {
        res.status(400).json({ error: 'userId query param required' })
        return
      }
      const projects = statements.getLocalProjects.all(userId)
      res.json(projects)
    } catch (error) {
      console.error('[LocalServer] Error fetching local projects:', error)
      res.status(500).json({ error: 'Failed to fetch local projects' })
    }
  })

  app.post('/api/local/projects', (req, res) => {
    try {
      const { id, name, user_id, context, system_prompt } = req.body
      if (!user_id) {
        res.status(400).json({ error: 'user_id required' })
        return
      }
      const projectId = id || uuidv4()
      const now = new Date().toISOString()
      statements.upsertProject.run(
        projectId,
        name || 'Untitled Project',
        user_id,
        context || null,
        system_prompt || null,
        'local',
        now,
        now
      )
      res.status(201).json(statements.getProjectById.get(projectId))
    } catch (error) {
      console.error('[LocalServer] Error creating local project:', error)
      res.status(500).json({ error: 'Failed to create local project' })
    }
  })

  // GET /api/local/projects/:id
  app.get('/api/local/projects/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] GET /api/local/projects/:id - projectId:', id)
      const project = statements.getProjectById.get(id)

      if (!project) {
        // console.log('[LocalServer] Project not found:', id)
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Verify it's actually a local project
      if (project.storage_mode !== 'local') {
        // console.log('[LocalServer] Project is not local storage:', id)
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // console.log('[LocalServer] Found local project:', id)
      res.json(project)
    } catch (error) {
      console.error('[LocalServer] Error fetching local project:', error)
      res.status(500).json({ error: 'Failed to fetch project' })
    }
  })

  // PATCH /api/local/projects/:id
  app.patch('/api/local/projects/:id', (req, res) => {
    try {
      const { id } = req.params
      const { name, context, system_prompt } = req.body

      const existing = statements.getProjectById.get(id) as any
      if (!existing) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Verify it's actually a local project
      if (existing.storage_mode !== 'local') {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Update only provided fields
      db!
        .prepare(
          `
        UPDATE projects SET 
          name = COALESCE(?, name),
          context = ?,
          system_prompt = ?,
          updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `
        )
        .run(
          name || existing.name,
          context !== undefined ? context : existing.context,
          system_prompt !== undefined ? system_prompt : existing.system_prompt,
          id
        )

      const updated = statements.getProjectById.get(id)
      // console.log('[LocalServer] Updated local project:', id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating local project:', error)
      res.status(500).json({ error: 'Failed to update project' })
    }
  })

  // PATCH /api/projects/:id/touch - Update project updated_at timestamp (for any project)
  // Called when a message is added to a conversation belonging to this project
  app.patch('/api/projects/:id/touch', (req, res) => {
    try {
      const { id } = req.params

      const existing = statements.getProjectById.get(id) as any
      if (!existing) {
        // Project doesn't exist locally - this is fine for cloud-only projects
        res.json({ success: true, id, touched: false, reason: 'project_not_found_locally' })
        return
      }

      // Update only the updated_at timestamp
      db!
        .prepare(
          `
        UPDATE projects SET
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
        )
        .run(id)

      // console.log('[LocalServer] Touched project timestamp:', id)
      res.json({ success: true, id, touched: true })
    } catch (error) {
      console.error('[LocalServer] Error touching project timestamp:', error)
      res.status(500).json({ error: 'Failed to touch project timestamp' })
    }
  })

  // GET /api/local/conversations?userId=xxx[&projectId=yyy]
  app.get('/api/local/conversations', (req, res) => {
    try {
      const userId = req.query.userId as string
      const projectId = (req.query.projectId as string | undefined) || undefined
      // console.log('[LocalServer] 📋 GET /api/local/conversations - userId:', userId, 'projectId:', projectId)
      if (!userId) {
        // console.log('[LocalServer] ❌ Missing userId parameter')
        res.status(400).json({ error: 'userId required' })
        return
      }

      const conversations = projectId
        ? statements.getLocalConversationsByUserAndProject.all(userId, projectId)
        : statements.getLocalConversations.all(userId)

      // console.log('[LocalServer] ✅ Found', conversations.length, 'local conversations for user:', userId)
      // console.log('[LocalServer] 📊 Conversations:', JSON.stringify(conversations, null, 2))
      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching local conversations:', error)
      res.status(500).json({ error: 'Failed to fetch conversations' })
    }
  })

  // GET /api/local/conversations/favorites?userId=xxx&limit=xx
  app.get('/api/local/conversations/favorites', (req, res) => {
    try {
      const userId = req.query.userId as string
      const limitParam = req.query.limit as string | undefined
      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      const limit = limitParam ? Number(limitParam) : undefined
      const conversations = Number.isFinite(limit)
        ? statements.getFavoriteConversationsLimited.all(userId, limit)
        : statements.getFavoriteConversations.all(userId)

      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching favorite conversations:', error)
      res.status(500).json({ error: 'Failed to fetch favorite conversations' })
    }
  })

  type TopLevelMessageSearchCandidate = {
    message_id: string
    conversation_id: string
    project_id: string | null
    storage_mode: 'cloud' | 'local'
    conversation_title: string | null
    conversation_updated_at: string | null
    message_created_at: string
    message_content: string
    message_plain_text_content: string | null
    message_note: string | null
    relevance: number
    match_type: 'fts' | 'fuzzy'
  }

  const TOP_LEVEL_MESSAGE_SEARCH_FTS_CANDIDATE_LIMIT = 220
  const TOP_LEVEL_MESSAGE_SEARCH_FUZZY_CANDIDATE_LIMIT = 900

  const normalizeSearchText = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  const splitSearchTokens = (value: string) => {
    const normalized = normalizeSearchText(value)
    if (!normalized) return []
    return Array.from(new Set(normalized.split(' ').filter(Boolean))).slice(0, 8)
  }

  const buildStrictFtsQuery = (tokens: string[]) => {
    if (tokens.length === 0) return ''
    return tokens.map(token => `"${token}"`).join(' AND ')
  }

  const buildRelaxedFtsQuery = (tokens: string[]) => {
    if (tokens.length === 0) return ''
    return tokens.map(token => `"${token}"*`).join(' OR ')
  }

  const levenshteinDistance = (a: string, b: string): number => {
    if (!a.length) return b.length
    if (!b.length) return a.length

    const matrix: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i
    for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j

    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        )
      }
    }

    return matrix[a.length][b.length]
  }

  const bestTokenSimilarity = (queryToken: string, candidateTokens: string[]): number => {
    let best = 0

    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) return 1

      if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) {
        best = Math.max(best, 0.92)
        continue
      }

      const maxLength = Math.max(queryToken.length, candidateToken.length)
      if (!maxLength) continue
      const distance = levenshteinDistance(queryToken, candidateToken)
      const similarity = 1 - distance / maxLength
      if (similarity > best) best = similarity
    }

    return best
  }

  const calculateFuzzyRelevance = (query: string, messageText: string, note: string | null): number => {
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery) return 0

    const combinedText = `${note || ''} ${messageText || ''}`
    const normalizedText = normalizeSearchText(combinedText)
    if (!normalizedText) return 0

    if (normalizedText.includes(normalizedQuery)) {
      return 1.2
    }

    const queryTokens = splitSearchTokens(query)
    if (queryTokens.length === 0) return 0

    const candidateTokens = Array.from(new Set(normalizedText.split(' ').filter(Boolean))).slice(0, 120)
    if (candidateTokens.length === 0) return 0

    let total = 0
    for (const queryToken of queryTokens) {
      total += bestTokenSimilarity(queryToken, candidateTokens)
    }

    const averageSimilarity = total / queryTokens.length
    const shortQueryBoost = normalizedQuery.length <= 5 ? 0.94 : 1
    return averageSimilarity * shortQueryBoost
  }

  const buildMessageSnippet = (rawText: string, rawQuery: string, maxLength: number = 220): string => {
    const text = (rawText || '').replace(/\s+/g, ' ').trim()
    if (!text) return ''
    if (text.length <= maxLength) return text

    const lowerText = text.toLowerCase()
    const lowerQuery = rawQuery.toLowerCase().trim()
    const matchIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1

    if (matchIndex === -1) {
      return `${text.slice(0, maxLength).trim()}…`
    }

    const halfWindow = Math.floor(maxLength / 2)
    const start = Math.max(0, matchIndex - halfWindow)
    const end = Math.min(text.length, start + maxLength)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < text.length ? '…' : ''
    return `${prefix}${text.slice(start, end).trim()}${suffix}`
  }

  const NOTE_SEARCH_FTS_CANDIDATE_LIMIT = 220
  const NOTE_SEARCH_FUZZY_CANDIDATE_LIMIT = 1200
  const NOTE_SEARCH_VECTOR_CANDIDATE_LIMIT = 80

  const normalizeEmbeddingInput = (embedding: unknown): number[] => {
    if (Array.isArray(embedding)) {
      return embedding.map(value => Number(value)).filter(value => Number.isFinite(value))
    }

    if (typeof embedding === 'string') {
      try {
        const parsed = JSON.parse(embedding)
        return normalizeEmbeddingInput(parsed)
      } catch {
        return []
      }
    }

    return []
  }

  const computeNoteContentHash = (note: string) => crypto.createHash('sha256').update(note, 'utf8').digest('hex')

  const getNoteVectorConfig = () => {
    const row = db!
      .prepare(
        `SELECT embedding_model, embedding_dimensions, vector_table_name, updated_at FROM note_search_vector_config WHERE id = 1`
      )
      .get() as
      | {
          embedding_model?: string | null
          embedding_dimensions?: number | null
          vector_table_name?: string | null
          updated_at?: string | null
        }
      | undefined

    return {
      embedding_model: row?.embedding_model || null,
      embedding_dimensions: Number(row?.embedding_dimensions || 0),
      vector_table_name:
        typeof row?.vector_table_name === 'string' && row.vector_table_name.trim().length > 0
          ? row.vector_table_name.trim()
          : 'note_search_vec',
      updated_at: row?.updated_at || null,
    }
  }

  const ensureNoteVectorTable = (dimensions: number) => {
    if (!sqliteVecAvailable) {
      throw new Error(sqliteVecLoadError || 'sqlite-vec unavailable')
    }

    const normalizedDimensions = Math.max(0, Math.floor(Number(dimensions)))
    if (!normalizedDimensions) {
      throw new Error('embedding dimensions must be a positive integer')
    }

    const vectorConfig = getNoteVectorConfig()
    const vectorTableName = vectorConfig.vector_table_name

    if (vectorConfig.embedding_dimensions && vectorConfig.embedding_dimensions !== normalizedDimensions) {
      throw new Error(
        `Existing note vector dimensions (${vectorConfig.embedding_dimensions}) do not match requested dimensions (${normalizedDimensions})`
      )
    }

    db!.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName} USING vec0(
        message_id TEXT PRIMARY KEY,
        embedding float[${normalizedDimensions}],
        user_id TEXT partition key,
        project_id TEXT,
        storage_mode TEXT,
        conversation_id TEXT,
        note_updated_at TEXT
      );
    `)

    db!
      .prepare(
        `
        UPDATE note_search_vector_config
        SET embedding_dimensions = ?,
            vector_table_name = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `
      )
      .run(normalizedDimensions, vectorTableName)

    return { ...getNoteVectorConfig(), embedding_dimensions: normalizedDimensions }
  }

  const getNoteVectorStatus = () => {
    const vectorConfig = getNoteVectorConfig()
    return {
      available: sqliteVecAvailable,
      error: sqliteVecLoadError,
      embedding_model: vectorConfig.embedding_model,
      embedding_dimensions: vectorConfig.embedding_dimensions || null,
      vector_table_name: vectorConfig.vector_table_name,
      configured: sqliteVecAvailable && vectorConfig.embedding_dimensions > 0,
    }
  }

  const upsertNoteEmbedding = (params: {
    messageId: string
    embedding: unknown
    embeddingModel?: string
    expectedUserId?: string
  }) => {
    const embedding = normalizeEmbeddingInput(params.embedding)
    if (embedding.length === 0) {
      throw new Error('embedding must be a non-empty numeric array')
    }

    const vectorConfig = ensureNoteVectorTable(embedding.length)
    const doc = db!
      .prepare(
        `
        SELECT
          message_id,
          conversation_id,
          project_id,
          user_id,
          storage_mode,
          note,
          note_updated_at
        FROM note_search_docs
        WHERE message_id = ?
      `
      )
      .get(params.messageId) as
      | {
          message_id: string
          conversation_id: string
          project_id: string | null
          user_id: string
          storage_mode: string
          note: string
          note_updated_at: string
        }
      | undefined

    if (!doc) {
      throw new Error('note search document not found for message_id')
    }

    if (params.expectedUserId && doc.user_id !== params.expectedUserId) {
      throw new Error('note search document does not belong to expected user')
    }

    const contentHash = computeNoteContentHash(doc.note || '')
    db!
      .prepare(
        `
        INSERT OR REPLACE INTO ${vectorConfig.vector_table_name} (
          message_id,
          embedding,
          user_id,
          project_id,
          storage_mode,
          conversation_id,
          note_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        doc.message_id,
        JSON.stringify(embedding),
        doc.user_id,
        doc.project_id,
        doc.storage_mode,
        doc.conversation_id,
        doc.note_updated_at
      )

    db!
      .prepare(
        `
        INSERT INTO note_search_embedding_state (
          message_id,
          content_hash,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'ready', NULL)
        ON CONFLICT(message_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          embedding_model = excluded.embedding_model,
          embedding_dimensions = excluded.embedding_dimensions,
          embedding_updated_at = CURRENT_TIMESTAMP,
          embedding_status = 'ready',
          last_error = NULL
      `
      )
      .run(doc.message_id, contentHash, params.embeddingModel || null, embedding.length)

    if (params.embeddingModel) {
      db!
        .prepare(
          `UPDATE note_search_vector_config SET embedding_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
        )
        .run(params.embeddingModel)
    }

    return {
      message_id: doc.message_id,
      conversation_id: doc.conversation_id,
      embedding_dimensions: embedding.length,
      embedding_model: params.embeddingModel || null,
      content_hash: contentHash,
    }
  }

  const markNoteEmbeddingState = (params: {
    messageId: string
    status: 'pending' | 'ready' | 'error' | 'stale'
    error?: string | null
    embeddingModel?: string | null
    embeddingDimensions?: number | null
  }) => {
    db!
      .prepare(
        `
        INSERT INTO note_search_embedding_state (
          message_id,
          embedding_model,
          embedding_dimensions,
          embedding_updated_at,
          embedding_status,
          last_error
        ) VALUES (?, ?, ?, CASE WHEN ? = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          embedding_model = COALESCE(excluded.embedding_model, note_search_embedding_state.embedding_model),
          embedding_dimensions = COALESCE(excluded.embedding_dimensions, note_search_embedding_state.embedding_dimensions),
          embedding_updated_at = CASE WHEN excluded.embedding_status = 'ready' THEN CURRENT_TIMESTAMP ELSE note_search_embedding_state.embedding_updated_at END,
          embedding_status = excluded.embedding_status,
          last_error = excluded.last_error
      `
      )
      .run(
        params.messageId,
        params.embeddingModel || null,
        params.embeddingDimensions || null,
        params.status,
        params.status,
        params.error || null
      )
  }

  const deleteNoteEmbedding = (messageId: string) => {
    const vectorConfig = getNoteVectorConfig()
    if (sqliteVecAvailable && vectorConfig.embedding_dimensions > 0) {
      try {
        db!.prepare(`DELETE FROM ${vectorConfig.vector_table_name} WHERE message_id = ?`).run(messageId)
      } catch (error) {
        console.warn('[LocalServer] Failed to delete note embedding row:', error)
      }
    }
    db!.prepare(`DELETE FROM note_search_embedding_state WHERE message_id = ?`).run(messageId)
  }

  const backfillNoteEmbeddings = async (params: {
    userId: string
    projectId?: string
    model?: string
    baseUrl?: string
    batchSize?: number
    limit?: number
    includeStatuses?: Array<'pending' | 'stale' | 'error'>
  }) => {
    const includeStatuses = Array.isArray(params.includeStatuses) && params.includeStatuses.length > 0
      ? params.includeStatuses.filter(status => ['pending', 'stale', 'error'].includes(status))
      : ['pending', 'stale', 'error']

    if (includeStatuses.length === 0) {
      throw new Error('includeStatuses must contain at least one of pending, stale, error')
    }

    const batchSize = Math.min(Math.max(Math.floor(Number(params.batchSize || 8)), 1), 32)
    const limit = Math.min(Math.max(Math.floor(Number(params.limit || 50)), 1), 500)
    const placeholders = includeStatuses.map(() => '?').join(', ')
    const whereProject = params.projectId ? 'AND d.project_id = ?' : ''

    const rows = db!
      .prepare(
        `
        SELECT
          d.message_id,
          d.conversation_id,
          d.project_id,
          d.user_id,
          d.note,
          d.note_updated_at,
          s.embedding_status,
          s.embedding_model,
          s.embedding_dimensions,
          s.content_hash,
          s.last_error
        FROM note_search_docs d
        INNER JOIN note_search_embedding_state s ON s.message_id = d.message_id
        WHERE d.user_id = ?
          ${whereProject}
          AND s.embedding_status IN (${placeholders})
        ORDER BY
          CASE s.embedding_status
            WHEN 'error' THEN 0
            WHEN 'stale' THEN 1
            ELSE 2
          END,
          datetime(d.note_updated_at) DESC
        LIMIT ?
      `
      )
      .all(
        params.userId,
        ...(params.projectId ? [params.projectId] : []),
        ...includeStatuses,
        limit
      ) as Array<{
        message_id: string
        conversation_id: string
        project_id: string | null
        user_id: string
        note: string
        note_updated_at: string
        embedding_status: 'pending' | 'stale' | 'error' | 'ready'
        embedding_model?: string | null
        embedding_dimensions?: number | null
        content_hash?: string | null
        last_error?: string | null
      }>

    if (rows.length === 0) {
      return {
        processed: 0,
        embedded: 0,
        failed: 0,
        skipped: 0,
        dimensions: getNoteVectorConfig().embedding_dimensions || null,
        model: params.model || getNoteVectorConfig().embedding_model || null,
        results: [] as Array<any>,
      }
    }

    const results: Array<any> = []
    let embedded = 0
    let failed = 0
    let skipped = 0
    let dimensions: number | null = getNoteVectorConfig().embedding_dimensions || null
    let resolvedModel: string | null = params.model || getNoteVectorConfig().embedding_model || null

    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize)
      const validBatch = batch.filter(row => typeof row.note === 'string' && row.note.trim().length > 0)

      for (const row of batch) {
        if (!validBatch.includes(row)) {
          skipped += 1
          results.push({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            status: 'skipped',
            reason: 'empty_note',
          })
        }
      }

      if (validBatch.length === 0) continue

      try {
        const embeddingResult = await embedTextsWithLmStudio({
          inputs: validBatch.map(row => row.note),
          model: params.model,
          inputType: 'document',
          baseUrl: params.baseUrl,
        })

        dimensions = embeddingResult.dimensions
        resolvedModel = embeddingResult.model

        for (let batchIndex = 0; batchIndex < validBatch.length; batchIndex += 1) {
          const row = validBatch[batchIndex]
          try {
            const upsertResult = upsertNoteEmbedding({
              messageId: row.message_id,
              embedding: embeddingResult.embeddings[batchIndex],
              embeddingModel: embeddingResult.model,
              expectedUserId: params.userId,
            })

            embedded += 1
            results.push({
              message_id: row.message_id,
              conversation_id: row.conversation_id,
              status: 'ready',
              embedding_dimensions: upsertResult.embedding_dimensions,
              embedding_model: upsertResult.embedding_model,
            })
          } catch (error) {
            failed += 1
            const message = error instanceof Error ? error.message : 'Failed to upsert note embedding'
            markNoteEmbeddingState({
              messageId: row.message_id,
              status: 'error',
              error: message,
              embeddingModel: embeddingResult.model,
              embeddingDimensions: embeddingResult.dimensions,
            })
            results.push({
              message_id: row.message_id,
              conversation_id: row.conversation_id,
              status: 'error',
              error: message,
            })
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate embeddings from LM Studio'
        failed += validBatch.length
        for (const row of validBatch) {
          markNoteEmbeddingState({
            messageId: row.message_id,
            status: 'error',
            error: message,
            embeddingModel: params.model || null,
            embeddingDimensions: dimensions,
          })
          results.push({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            status: 'error',
            error: message,
          })
        }
      }
    }

    return {
      processed: rows.length,
      embedded,
      failed,
      skipped,
      dimensions,
      model: resolvedModel,
      results,
    }
  }

  const vectorSearchNotes = (params: {
    userId: string
    queryEmbedding: unknown
    projectId?: string
    limit: number
  }) => {
    if (!sqliteVecAvailable) return [] as Array<any>

    const queryEmbedding = normalizeEmbeddingInput(params.queryEmbedding)
    if (queryEmbedding.length === 0) {
      throw new Error('query embedding must be a non-empty numeric array')
    }

    const vectorConfig = getNoteVectorConfig()
    if (!vectorConfig.embedding_dimensions) {
      throw new Error('note vector search is not configured yet')
    }
    if (vectorConfig.embedding_dimensions !== queryEmbedding.length) {
      throw new Error(
        `query embedding dimensions (${queryEmbedding.length}) do not match configured dimensions (${vectorConfig.embedding_dimensions})`
      )
    }

    const whereProject = params.projectId ? 'AND project_id = ?' : ''
    const rows = db!
      .prepare(
        `
        SELECT
          message_id,
          conversation_id,
          project_id,
          storage_mode,
          note_updated_at,
          distance
        FROM ${vectorConfig.vector_table_name}
        WHERE embedding MATCH ?
          AND k = ?
          AND user_id = ?
          ${whereProject}
        ORDER BY distance
      `
      )
      .all(
        JSON.stringify(queryEmbedding),
        Math.max(params.limit, 1),
        params.userId,
        ...(params.projectId ? [params.projectId] : [])
      ) as Array<any>

    return rows
  }

  const clampNoteSearchScore = (value: number, min: number = 0, max: number = 1) =>
    Math.min(max, Math.max(min, value))

  const getNoteSearchLexicalSignals = (params: {
    queryTokens: string[]
    normalizedQuery: string
    conversationTitle: string | null
    note: string
  }) => {
    const normalizedTitle = normalizeSearchText(params.conversationTitle || '')
    const normalizedText = normalizeSearchText(`${params.conversationTitle || ''} ${params.note || ''}`)
    const candidateTokens = Array.from(new Set(normalizedText.split(' ').filter(Boolean))).slice(0, 160)
    const candidateTokenSet = new Set(candidateTokens)
    const titleTokenSet = new Set(normalizedTitle.split(' ').filter(Boolean))

    let exactTokenMatches = 0
    let partialTokenMatches = 0
    let titleExactTokenMatches = 0

    for (const token of params.queryTokens) {
      if (candidateTokenSet.has(token)) {
        exactTokenMatches += 1
      } else if (candidateTokens.some(candidateToken => candidateToken.includes(token) || token.includes(candidateToken))) {
        partialTokenMatches += 1
      }

      if (titleTokenSet.has(token)) {
        titleExactTokenMatches += 1
      }
    }

    const phraseMatch = Boolean(params.normalizedQuery && normalizedText.includes(params.normalizedQuery))
    const exactCoverage = params.queryTokens.length > 0 ? exactTokenMatches / params.queryTokens.length : 0
    const partialCoverage =
      params.queryTokens.length > 0 ? Math.min(1, (exactTokenMatches + partialTokenMatches) / params.queryTokens.length) : 0

    const lexicalBoost = clampNoteSearchScore(
      (phraseMatch ? 0.32 : 0) +
        exactCoverage * 0.55 +
        exactTokenMatches * 0.08 +
        Math.max(partialCoverage - exactCoverage, 0) * 0.16 +
        Math.min(titleExactTokenMatches, 2) * 0.05,
      0,
      1.25
    )

    return {
      exact_token_matches: exactTokenMatches,
      partial_token_matches: partialTokenMatches,
      title_exact_token_matches: titleExactTokenMatches,
      exact_coverage: exactCoverage,
      partial_coverage: partialCoverage,
      phrase_match: phraseMatch,
      lexical_boost: lexicalBoost,
    }
  }

  const getNoteSearchVectorPenaltyFactor = (params: {
    queryTokens: string[]
    exactCoverage: number
    partialCoverage: number
    phraseMatch: boolean
  }) => {
    if (params.phraseMatch || params.queryTokens.length === 0 || params.queryTokens.length > 6) {
      return 1
    }

    if (params.exactCoverage >= 0.5) {
      return 1
    }

    if (params.exactCoverage > 0) {
      return 0.88
    }

    if (params.partialCoverage > 0) {
      return 0.68
    }

    return 0.42
  }

  const searchNotes = (params: {
    userId: string
    query: string
    projectId?: string
    limit: number
    queryEmbedding?: unknown
    vectorWeight?: number
    lexicalWeight?: number
    recencyWeight?: number
  }) => {
    const {
      userId,
      query,
      projectId,
      limit,
      queryEmbedding,
      vectorWeight = 0.45,
      lexicalWeight = 0.45,
      recencyWeight = 0.1,
    } = params
    const trimmedQuery = query.trim()
    const queryTokens = splitSearchTokens(trimmedQuery)
    const normalizedQuery = normalizeSearchText(trimmedQuery)

    type NoteSearchSourceType = 'fts' | 'fuzzy' | 'vector'
    type NoteSearchMatchType = NoteSearchSourceType | 'hybrid'

    type NoteSearchCandidate = {
      message_id: string
      conversation_id: string
      project_id: string | null
      storage_mode: 'cloud' | 'local'
      conversation_title: string | null
      message_created_at: string
      note_updated_at: string
      note: string
      match_type: NoteSearchMatchType
      source_match_types?: NoteSearchSourceType[]
      relevance: number
      vector_distance?: number | null
      lexical_score?: number | null
      vector_score?: number | null
      recency_score?: number | null
      exact_token_matches?: number
      partial_token_matches?: number
      exact_token_coverage?: number
      token_coverage?: number
      phrase_match?: boolean
    }

    const candidateMap = new Map<string, NoteSearchCandidate>()
    const scopeClause = projectId ? ' AND project_id = ?' : ''
    const scopeParams = projectId ? [userId, projectId] : [userId]

    const pushCandidate = (candidate: NoteSearchCandidate) => {
      const existing = candidateMap.get(candidate.message_id)
      if (!existing) {
        candidateMap.set(candidate.message_id, {
          ...candidate,
          source_match_types:
            candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType]),
        })
        return
      }

      const existingTypes = existing.source_match_types || (existing.match_type === 'hybrid' ? [] : [existing.match_type as NoteSearchSourceType])
      const candidateTypes =
        candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType])
      const mergedTypes = Array.from(new Set([...existingTypes, ...candidateTypes]))

      const existingVectorDistance = typeof existing.vector_distance === 'number' ? existing.vector_distance : null
      const candidateVectorDistance = typeof candidate.vector_distance === 'number' ? candidate.vector_distance : null

      candidateMap.set(candidate.message_id, {
        ...existing,
        relevance: Math.max(existing.relevance, candidate.relevance),
        lexical_score: Math.max(existing.lexical_score ?? 0, candidate.lexical_score ?? 0) || undefined,
        vector_score: Math.max(existing.vector_score ?? 0, candidate.vector_score ?? 0) || undefined,
        vector_distance:
          existingVectorDistance === null
            ? candidateVectorDistance
            : candidateVectorDistance === null
              ? existingVectorDistance
              : Math.min(existingVectorDistance, candidateVectorDistance),
        source_match_types: mergedTypes,
      })
    }

    if (queryEmbedding !== undefined && queryEmbedding !== null) {
      try {
        const vectorRows = vectorSearchNotes({
          userId,
          queryEmbedding,
          projectId,
          limit: Math.max(limit, NOTE_SEARCH_VECTOR_CANDIDATE_LIMIT),
        })

        for (const row of vectorRows) {
          const doc = db!
            .prepare(
              `
              SELECT
                message_id,
                conversation_id,
                project_id,
                storage_mode,
                conversation_title,
                message_created_at,
                note_updated_at,
                note
              FROM note_search_docs
              WHERE message_id = ?
            `
            )
            .get(String(row.message_id)) as
            | {
                message_id: string
                conversation_id: string
                project_id: string | null
                storage_mode: string
                conversation_title: string | null
                message_created_at: string
                note_updated_at: string
                note: string
              }
            | undefined

          if (!doc) continue

          const distanceValue = Number(row.distance)
          const vectorScore = Number.isFinite(distanceValue) ? 1 / (1 + Math.max(distanceValue, 0)) : 0

          pushCandidate({
            message_id: doc.message_id,
            conversation_id: doc.conversation_id,
            project_id: doc.project_id || null,
            storage_mode: doc.storage_mode === 'cloud' ? 'cloud' : 'local',
            conversation_title: doc.conversation_title || null,
            message_created_at: doc.message_created_at,
            note_updated_at: doc.note_updated_at,
            note: doc.note || '',
            match_type: 'vector',
            relevance: vectorScore,
            vector_distance: Number.isFinite(distanceValue) ? distanceValue : null,
            vector_score: vectorScore,
          })
        }
      } catch (vectorSearchError) {
        console.warn('[LocalServer] Note vector search failed, continuing with lexical search only:', vectorSearchError)
      }
    }

    const tryRunFts = (ftsQuery: string) => {
      if (!ftsQuery) return

      const rows = db!
        .prepare(
          `
          SELECT
            d.message_id,
            d.conversation_id,
            d.project_id,
            d.storage_mode,
            d.conversation_title,
            d.message_created_at,
            d.note_updated_at,
            d.note,
            bm25(note_search_fts) AS fts_rank
          FROM note_search_fts
          INNER JOIN note_search_docs d ON d.message_id = note_search_fts.message_id
          WHERE note_search_fts MATCH ?
            AND d.user_id = ?
            ${scopeClause}
          ORDER BY fts_rank ASC, datetime(d.note_updated_at) DESC, datetime(d.message_created_at) DESC
          LIMIT ?
        `
        )
        .all(ftsQuery, ...scopeParams, NOTE_SEARCH_FTS_CANDIDATE_LIMIT) as Array<any>

      for (const row of rows) {
        const normalizedText = normalizeSearchText(`${row.conversation_title || ''} ${row.note || ''}`)
        const rank = Number.isFinite(Number(row.fts_rank)) ? Math.max(Number(row.fts_rank), 0) : 10
        const rankBoost = 1 / (1 + rank)
        const containsBoost = normalizedQuery && normalizedText.includes(normalizedQuery) ? 0.12 : 0
        const lexicalScore = 0.74 + rankBoost * 0.18 + containsBoost

        pushCandidate({
          message_id: String(row.message_id),
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          message_created_at: row.message_created_at,
          note_updated_at: row.note_updated_at,
          note: row.note || '',
          match_type: 'fts',
          relevance: lexicalScore,
          lexical_score: lexicalScore,
        })
      }
    }

    if (queryTokens.length > 0) {
      try {
        tryRunFts(buildStrictFtsQuery(queryTokens))
      } catch {
        // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
      }

      if (candidateMap.size < limit * 2) {
        try {
          tryRunFts(buildRelaxedFtsQuery(queryTokens))
        } catch {
          // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
        }
      }
    }

    if (candidateMap.size < limit * 2) {
      const recentRows = db!
        .prepare(
          `
          SELECT
            message_id,
            conversation_id,
            project_id,
            storage_mode,
            conversation_title,
            message_created_at,
            note_updated_at,
            note
          FROM note_search_docs
          WHERE user_id = ?
            ${scopeClause}
          ORDER BY datetime(note_updated_at) DESC, datetime(message_created_at) DESC
          LIMIT ?
        `
        )
        .all(...scopeParams, NOTE_SEARCH_FUZZY_CANDIDATE_LIMIT) as Array<any>

      const fuzzyThreshold = normalizedQuery.length <= 5 ? 0.78 : 0.64

      for (const row of recentRows) {
        const messageId = String(row.message_id)
        if (candidateMap.has(messageId)) continue

        const fuzzyRelevance = calculateFuzzyRelevance(
          trimmedQuery,
          `${row.conversation_title || ''} ${row.note || ''}`,
          row.note || null
        )
        if (fuzzyRelevance < fuzzyThreshold) continue

        const lexicalScore = clampNoteSearchScore(fuzzyRelevance, 0, 1.05)

        pushCandidate({
          message_id: messageId,
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          message_created_at: row.message_created_at,
          note_updated_at: row.note_updated_at,
          note: row.note || '',
          match_type: 'fuzzy',
          relevance: lexicalScore,
          lexical_score: lexicalScore,
        })
      }
    }

    const now = Date.now()
    const maxAgeMs = 180 * 24 * 60 * 60 * 1000

    const scoredCandidates = Array.from(candidateMap.values())
      .map(candidate => {
        const lexicalSignals = getNoteSearchLexicalSignals({
          queryTokens,
          normalizedQuery,
          conversationTitle: candidate.conversation_title,
          note: candidate.note,
        })

        const baseLexicalScore = Math.max(candidate.lexical_score ?? 0, 0)
        const lexicalScore = clampNoteSearchScore(baseLexicalScore + lexicalSignals.lexical_boost, 0, 1.75)

        const rawVectorScore = Math.max(candidate.vector_score ?? 0, 0)
        const vectorPenaltyFactor =
          rawVectorScore > 0
            ? getNoteSearchVectorPenaltyFactor({
                queryTokens,
                exactCoverage: lexicalSignals.exact_coverage,
                partialCoverage: lexicalSignals.partial_coverage,
                phraseMatch: lexicalSignals.phrase_match,
              })
            : 1
        const vectorScore = rawVectorScore * vectorPenaltyFactor

        const updatedMs = new Date(candidate.note_updated_at || candidate.message_created_at).getTime()
        const ageMs = Number.isFinite(updatedMs) ? Math.max(now - updatedMs, 0) : maxAgeMs
        const recencyScore = candidate.recency_score ?? Math.max(0, 1 - ageMs / maxAgeMs)
        const combinedScore = vectorWeight * vectorScore + lexicalWeight * lexicalScore + recencyWeight * recencyScore

        const sourceMatchTypes =
          candidate.source_match_types || (candidate.match_type === 'hybrid' ? [] : [candidate.match_type as NoteSearchSourceType])
        const hasVectorSignal = vectorScore > 0 || sourceMatchTypes.includes('vector')
        const hasLexicalSignal = lexicalScore > 0
        const matchType: NoteSearchMatchType = hasVectorSignal && hasLexicalSignal
          ? 'hybrid'
          : hasVectorSignal
            ? 'vector'
            : sourceMatchTypes.includes('fts')
              ? 'fts'
              : 'fuzzy'

        return {
          ...candidate,
          match_type: matchType,
          source_match_types: sourceMatchTypes,
          lexical_score: lexicalScore,
          vector_score: vectorScore,
          recency_score: recencyScore,
          relevance: combinedScore,
          exact_token_matches: lexicalSignals.exact_token_matches,
          partial_token_matches: lexicalSignals.partial_token_matches,
          exact_token_coverage: lexicalSignals.exact_coverage,
          token_coverage: lexicalSignals.partial_coverage,
          phrase_match: lexicalSignals.phrase_match,
        }
      })
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance
        const aTime = new Date(a.note_updated_at || a.message_created_at).getTime()
        const bTime = new Date(b.note_updated_at || b.message_created_at).getTime()
        return bTime - aTime
      })

    const groupedByConversation = new Map<
      string,
      {
        best: NoteSearchCandidate
        conversation_hit_count: number
        matched_message_ids: string[]
        source_match_types: Set<NoteSearchSourceType>
      }
    >()

    for (const candidate of scoredCandidates) {
      const existing = groupedByConversation.get(candidate.conversation_id)
      const sourceTypes = candidate.source_match_types || []

      if (!existing) {
        groupedByConversation.set(candidate.conversation_id, {
          best: candidate,
          conversation_hit_count: 1,
          matched_message_ids: [candidate.message_id],
          source_match_types: new Set(sourceTypes),
        })
        continue
      }

      existing.conversation_hit_count += 1
      if (!existing.matched_message_ids.includes(candidate.message_id)) {
        existing.matched_message_ids.push(candidate.message_id)
      }
      for (const sourceType of sourceTypes) {
        existing.source_match_types.add(sourceType)
      }
    }

    return Array.from(groupedByConversation.values())
      .sort((a, b) => {
        if (b.best.relevance !== a.best.relevance) return b.best.relevance - a.best.relevance
        const aTime = new Date(a.best.note_updated_at || a.best.message_created_at).getTime()
        const bTime = new Date(b.best.note_updated_at || b.best.message_created_at).getTime()
        return bTime - aTime
      })
      .slice(0, limit)
      .map(group => ({
        conversation_id: group.best.conversation_id,
        project_id: group.best.project_id,
        storage_mode: group.best.storage_mode,
        conversation_title: group.best.conversation_title,
        message_id: group.best.message_id,
        message_created_at: group.best.message_created_at,
        note_updated_at: group.best.note_updated_at,
        note: buildMessageSnippet(group.best.note, trimmedQuery),
        match_type: group.best.match_type,
        source_match_types: Array.from(group.source_match_types),
        score: Number(group.best.relevance.toFixed(6)),
        lexical_score: Number((group.best.lexical_score || 0).toFixed(6)),
        vector_score: Number((group.best.vector_score || 0).toFixed(6)),
        recency_score: Number((group.best.recency_score || 0).toFixed(6)),
        vector_distance: group.best.vector_distance ?? null,
        conversation_hit_count: group.conversation_hit_count,
        matched_message_ids: group.matched_message_ids.slice(0, 5),
        why_matched: {
          exact_token_matches: group.best.exact_token_matches || 0,
          partial_token_matches: group.best.partial_token_matches || 0,
          exact_token_coverage: Number((group.best.exact_token_coverage || 0).toFixed(6)),
          token_coverage: Number((group.best.token_coverage || 0).toFixed(6)),
          phrase_match: Boolean(group.best.phrase_match),
        },
      }))
  }

  const searchTopLevelUserMessages = (params: {
    userId: string
    query: string
    projectId?: string
    limit: number
  }) => {
    const { userId, query, projectId, limit } = params
    const trimmedQuery = query.trim()
    const queryTokens = splitSearchTokens(trimmedQuery)
    const normalizedQuery = normalizeSearchText(trimmedQuery)

    const candidateMap = new Map<string, TopLevelMessageSearchCandidate>()
    const scopeClause = projectId ? ' AND c.project_id = ?' : ''
    const scopeParams = projectId ? [userId, projectId] : [userId]

    const pushCandidate = (candidate: TopLevelMessageSearchCandidate) => {
      const existing = candidateMap.get(candidate.message_id)
      if (!existing || candidate.relevance > existing.relevance) {
        candidateMap.set(candidate.message_id, candidate)
      }
    }

    const tryRunFts = (ftsQuery: string) => {
      if (!ftsQuery) return

      const ftsRows = db!
        .prepare(
          `
          SELECT
            m.id AS message_id,
            m.conversation_id AS conversation_id,
            c.project_id AS project_id,
            c.storage_mode AS storage_mode,
            c.title AS conversation_title,
            c.updated_at AS conversation_updated_at,
            m.created_at AS message_created_at,
            m.content AS message_content,
            m.plain_text_content AS message_plain_text_content,
            m.note AS message_note,
            bm25(top_level_user_message_search) AS fts_rank
          FROM top_level_user_message_search
          INNER JOIN messages m ON m.id = top_level_user_message_search.message_id
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE top_level_user_message_search MATCH ?
            AND c.user_id = ?
            ${scopeClause}
          ORDER BY fts_rank ASC, datetime(COALESCE(c.updated_at, c.created_at)) DESC, datetime(m.created_at) DESC
          LIMIT ?
        `
        )
        .all(ftsQuery, ...scopeParams, TOP_LEVEL_MESSAGE_SEARCH_FTS_CANDIDATE_LIMIT) as Array<any>

      for (const row of ftsRows) {
        const messageText = row.message_plain_text_content || row.message_content || ''
        const normalizedText = normalizeSearchText(`${row.message_note || ''} ${messageText}`)
        const rank = Number.isFinite(Number(row.fts_rank)) ? Math.max(Number(row.fts_rank), 0) : 10
        const rankBoost = 1 / (1 + rank)
        const containsBoost = normalizedQuery && normalizedText.includes(normalizedQuery) ? 0.25 : 0

        pushCandidate({
          message_id: String(row.message_id),
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          conversation_updated_at: row.conversation_updated_at || null,
          message_created_at: row.message_created_at,
          message_content: row.message_content || '',
          message_plain_text_content: row.message_plain_text_content || null,
          message_note: row.message_note || null,
          match_type: 'fts',
          relevance: 2 + rankBoost + containsBoost,
        })
      }
    }

    if (queryTokens.length > 0) {
      try {
        tryRunFts(buildStrictFtsQuery(queryTokens))
      } catch {
        // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
      }

      if (candidateMap.size < limit) {
        try {
          tryRunFts(buildRelaxedFtsQuery(queryTokens))
        } catch {
          // FTS5 may be unavailable in some SQLite builds; fuzzy fallback still works.
        }
      }
    }

    if (candidateMap.size < limit) {
      const recentRows = db!
        .prepare(
          `
          SELECT
            m.id AS message_id,
            m.conversation_id AS conversation_id,
            c.project_id AS project_id,
            c.storage_mode AS storage_mode,
            c.title AS conversation_title,
            c.updated_at AS conversation_updated_at,
            m.created_at AS message_created_at,
            m.content AS message_content,
            m.plain_text_content AS message_plain_text_content,
            m.note AS message_note
          FROM messages m
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ?
            ${scopeClause}
            AND m.parent_id IS NULL
            AND m.role = 'user'
          ORDER BY datetime(COALESCE(c.updated_at, c.created_at)) DESC, datetime(m.created_at) DESC
          LIMIT ?
        `
        )
        .all(...scopeParams, TOP_LEVEL_MESSAGE_SEARCH_FUZZY_CANDIDATE_LIMIT) as Array<any>

      const fuzzyThreshold = normalizedQuery.length <= 5 ? 0.78 : 0.64

      for (const row of recentRows) {
        const messageId = String(row.message_id)
        if (candidateMap.has(messageId)) continue

        const messageText = row.message_plain_text_content || row.message_content || ''
        const fuzzyRelevance = calculateFuzzyRelevance(trimmedQuery, messageText, row.message_note || null)
        if (fuzzyRelevance < fuzzyThreshold) continue

        pushCandidate({
          message_id: messageId,
          conversation_id: String(row.conversation_id),
          project_id: row.project_id || null,
          storage_mode: row.storage_mode === 'cloud' ? 'cloud' : 'local',
          conversation_title: row.conversation_title || null,
          conversation_updated_at: row.conversation_updated_at || null,
          message_created_at: row.message_created_at,
          message_content: row.message_content || '',
          message_plain_text_content: row.message_plain_text_content || null,
          message_note: row.message_note || null,
          match_type: 'fuzzy',
          relevance: fuzzyRelevance,
        })
      }
    }

    return Array.from(candidateMap.values())
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance
        const aConversationTime = new Date(a.conversation_updated_at || a.message_created_at).getTime()
        const bConversationTime = new Date(b.conversation_updated_at || b.message_created_at).getTime()
        if (bConversationTime !== aConversationTime) return bConversationTime - aConversationTime
        const aMessageTime = new Date(a.message_created_at).getTime()
        const bMessageTime = new Date(b.message_created_at).getTime()
        return bMessageTime - aMessageTime
      })
      .slice(0, limit)
      .map(candidate => {
        const messageText = candidate.message_plain_text_content || candidate.message_content || ''
        return {
          conversation_id: candidate.conversation_id,
          project_id: candidate.project_id,
          storage_mode: candidate.storage_mode,
          conversation_title: candidate.conversation_title,
          message_id: candidate.message_id,
          message_created_at: candidate.message_created_at,
          conversation_updated_at: candidate.conversation_updated_at,
          content: buildMessageSnippet(messageText, trimmedQuery),
          note: candidate.message_note,
          match_type: candidate.match_type,
          score: Number(candidate.relevance.toFixed(6)),
        }
      })
  }

  // GET /api/local/conversations/search?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const trimmedQuery = rawQuery.trim()
      const normalizedQuery = trimmedQuery.replace(/[\s_-]+/g, '')
      const likeQuery = `%${trimmedQuery}%`
      const normalizedLikeQuery = `%${normalizedQuery || trimmedQuery}%`
      const conversations = projectId
        ? statements.searchConversationsByTitleInProject.all(userId, projectId, likeQuery, normalizedLikeQuery, limit)
        : statements.searchConversationsByTitle.all(userId, likeQuery, normalizedLikeQuery, limit)

      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching conversations by title:', error)
      res.status(500).json({ error: 'Failed to search conversations' })
    }
  })

  // GET /api/local/conversations/search/notes?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search/notes', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)
      const queryEmbedding = req.query.embedding

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchNotes({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json({
        results,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching notes:', error)
      res.status(500).json({ error: 'Failed to search notes' })
    }
  })

  // POST /api/local/conversations/search/notes/search
  app.post('/api/local/conversations/search/notes/search', (req, res) => {
    try {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const rawQuery = typeof req.body?.q === 'string' ? req.body.q : ''
      const projectId = typeof req.body?.projectId === 'string' && req.body.projectId.trim().length > 0 ? req.body.projectId.trim() : undefined
      const rawLimit = Number(req.body?.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchNotes({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json({
        results,
        query: rawQuery,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching notes:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to search notes' })
    }
  })

  // GET /api/local/conversations/search/notes/vector-status
  app.get('/api/local/conversations/search/notes/vector-status', (_req, res) => {
    try {
      res.json(getNoteVectorStatus())
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching note vector status:', error)
      res.status(500).json({ error: 'Failed to fetch note vector status' })
    }
  })

  // POST /api/local/conversations/search/notes/configure-vector
  app.post('/api/local/conversations/search/notes/configure-vector', (req, res) => {
    try {
      const embeddingDimensions = Number(req.body?.embeddingDimensions)
      const embeddingModel = typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel.trim() : ''

      if (!Number.isFinite(embeddingDimensions) || embeddingDimensions <= 0) {
        res.status(400).json({ error: 'embeddingDimensions must be a positive integer' })
        return
      }

      const vectorConfig = ensureNoteVectorTable(embeddingDimensions)
      if (embeddingModel) {
        db!
          .prepare(`UPDATE note_search_vector_config SET embedding_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
          .run(embeddingModel)
      }

      res.json({
        success: true,
        sqlite_vec: getNoteVectorStatus(),
        vector_config: {
          ...vectorConfig,
          embedding_model: embeddingModel || vectorConfig.embedding_model,
        },
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error configuring note vector table:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to configure note vector table' })
    }
  })

  // POST /api/local/conversations/search/notes/upsert-embedding
  app.post('/api/local/conversations/search/notes/upsert-embedding', (req, res) => {
    try {
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const embedding = req.body?.embedding
      const embeddingModel = typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel.trim() : ''
      const expectedUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''

      if (!messageId) {
        res.status(400).json({ error: 'messageId required' })
        return
      }

      const result = upsertNoteEmbedding({
        messageId,
        embedding,
        embeddingModel: embeddingModel || undefined,
        expectedUserId: expectedUserId || undefined,
      })

      res.json({ success: true, result, sqlite_vec: getNoteVectorStatus() })
    } catch (error) {
      console.error('[LocalServer] ❌ Error upserting note embedding:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upsert note embedding' })
    }
  })

  // POST /api/local/conversations/search/notes/mark-embedding-state
  app.post('/api/local/conversations/search/notes/mark-embedding-state', (req, res) => {
    try {
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const status = req.body?.status as 'pending' | 'ready' | 'error' | 'stale'

      if (!messageId) {
        res.status(400).json({ error: 'messageId required' })
        return
      }

      if (!['pending', 'ready', 'error', 'stale'].includes(status)) {
        res.status(400).json({ error: 'status must be one of pending, ready, error, stale' })
        return
      }

      markNoteEmbeddingState({
        messageId,
        status,
        error: typeof req.body?.error === 'string' ? req.body.error : null,
        embeddingModel: typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel : null,
        embeddingDimensions:
          req.body?.embeddingDimensions !== undefined ? Number(req.body.embeddingDimensions) : null,
      })

      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error marking note embedding state:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mark note embedding state' })
    }
  })

  // POST /api/local/conversations/search/notes/embed
  app.post('/api/local/conversations/search/notes/embed', async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
      const inputTypeRaw = typeof req.body?.inputType === 'string' ? req.body.inputType.trim().toLowerCase() : ''
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
      const expectedUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const upsert = req.body?.upsert === true

      if (!text) {
        res.status(400).json({ error: 'text required' })
        return
      }

      const inputType = inputTypeRaw === 'query' || inputTypeRaw === 'document' ? inputTypeRaw : 'none'
      const embeddingResult = await embedTextWithLmStudio({
        text,
        model: model || undefined,
        inputType,
        baseUrl: baseUrl || undefined,
      })

      let upsertResult: ReturnType<typeof upsertNoteEmbedding> | null = null
      if (upsert) {
        if (!messageId) {
          res.status(400).json({ error: 'messageId required when upsert=true' })
          return
        }

        upsertResult = upsertNoteEmbedding({
          messageId,
          embedding: embeddingResult.embedding,
          embeddingModel: embeddingResult.model,
          expectedUserId: expectedUserId || undefined,
        })
      }

      res.json({
        success: true,
        model: embeddingResult.model,
        input_type: embeddingResult.inputType,
        dimensions: embeddingResult.dimensions,
        embedding: embeddingResult.embedding,
        upserted: upsert,
        upsert_result: upsertResult,
        lmstudio: {
          base_url: getLmStudioBaseUrl(baseUrl || undefined),
        },
        sqlite_vec: getNoteVectorStatus(),
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error generating note embedding with LM Studio:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate note embedding' })
    }
  })

  // POST /api/local/conversations/search/notes/backfill-missing
  app.post('/api/local/conversations/search/notes/backfill-missing', async (req, res) => {
    try {
      const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : ''
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : ''
      const batchSize = req.body?.batchSize !== undefined ? Number(req.body.batchSize) : undefined
      const limit = req.body?.limit !== undefined ? Number(req.body.limit) : undefined
      const includeStatuses = Array.isArray(req.body?.includeStatuses) ? req.body.includeStatuses : undefined

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      const result = await backfillNoteEmbeddings({
        userId,
        projectId: projectId || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        batchSize,
        limit,
        includeStatuses,
      })

      res.json({
        success: true,
        result,
        lmstudio: {
          base_url: getLmStudioBaseUrl(baseUrl || undefined),
        },
        sqlite_vec: getNoteVectorStatus(),
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error backfilling note embeddings with LM Studio:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to backfill note embeddings' })
    }
  })

  // GET /api/local/conversations/search/top-level-users?userId=xxx&q=term&limit=20&projectId=xxx
  app.get('/api/local/conversations/search/top-level-users', (req, res) => {
    try {
      const userId = req.query.userId as string
      const rawQuery = (req.query.q as string) || ''
      const projectId = (req.query.projectId as string | undefined) || undefined
      const rawLimit = Number(req.query.limit ?? 20)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 50)

      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (!rawQuery.trim()) {
        res.status(400).json({ error: 'q required' })
        return
      }

      const results = searchTopLevelUserMessages({
        userId,
        query: rawQuery,
        projectId,
        limit,
      })

      res.json(results)
    } catch (error) {
      console.error('[LocalServer] ❌ Error searching top-level user messages:', error)
      res.status(500).json({ error: 'Failed to search top-level user messages' })
    }
  })

  // POST /api/local/conversations
  app.post('/api/local/conversations', (req, res) => {
    try {
      const { id, user_id, project_id, title, system_prompt, conversation_context } = req.body
      if (!user_id) {
        res.status(400).json({ error: 'user_id required' })
        return
      }

      const conversationId = id || uuidv4()
      const now = new Date().toISOString()

      statements.upsertConversation.run(
        conversationId,
        project_id || null,
        user_id,
        title || null,
        'unknown', // model_name
        system_prompt || null,
        conversation_context || null,
        null, // research_note
        null, // cwd
        'local', // storage_mode
        now,
        now
      )

      // Touch parent project timestamp so project ordering reflects latest conversation activity
      if (project_id) {
        db!.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project_id)
      }

      const created = statements.getConversationById.get(conversationId)
      res.status(201).json(created)
    } catch (error) {
      console.error('[LocalServer] Error creating local conversation:', error)
      res.status(500).json({ error: 'Failed to create conversation' })
    }
  })

  // PATCH /api/local/conversations/:id
  // Handles: title, system_prompt, conversation_context, research_note, cwd
  app.patch('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      const { title, system_prompt, conversation_context, research_note, cwd } = req.body

      const existing = statements.getConversationById.get(id) as any
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // Build dynamic update - only update fields that are provided (not undefined)
      const updates: string[] = []
      const values: any[] = []

      if (title !== undefined) {
        updates.push('title = ?')
        values.push(title)
      }
      if (system_prompt !== undefined) {
        updates.push('system_prompt = ?')
        values.push(system_prompt)
      }
      if (conversation_context !== undefined) {
        updates.push('conversation_context = ?')
        values.push(conversation_context)
      }
      if (research_note !== undefined) {
        updates.push('research_note = ?')
        values.push(research_note)
      }
      if (cwd !== undefined) {
        updates.push('cwd = ?')
        values.push(cwd)
      }

      if (updates.length === 0) {
        // Nothing to update, just return existing
        res.json(existing)
        return
      }

      // Always update updated_at
      updates.push('updated_at = CURRENT_TIMESTAMP')
      values.push(id) // for WHERE clause

      const sql = `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`
      db!.prepare(sql).run(...values)

      const updated = statements.getConversationById.get(id)
      // console.log('[LocalServer] Updated local conversation:', id, '- fields:', Object.keys(req.body).join(', '))
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating conversation:', error)
      res.status(500).json({ error: 'Failed to update conversation' })
    }
  })

  // PATCH /api/local/conversations/:id/favorite
  app.patch('/api/local/conversations/:id/favorite', (req, res) => {
    try {
      const { id } = req.params
      const { favorite } = req.body || {}

      if (favorite === undefined) {
        res.status(400).json({ error: 'favorite required' })
        return
      }

      const existing = statements.getConversationById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      const normalizedFavorite = favorite === true || favorite === 1 || favorite === '1' || favorite === 'true' ? 1 : 0

      statements.updateConversationFavorite.run(normalizedFavorite, id)
      const updated = statements.getConversationById.get(id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating conversation favorite:', error)
      res.status(500).json({ error: 'Failed to update favorite' })
    }
  })

  // GET /api/local/conversations/:id
  app.get('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🔍 GET /api/local/conversations/:id - conversationId:', id)
      const conversation = statements.getConversationById.get(id)

      if (!conversation) {
        // console.log('[LocalServer] ❌ Conversation not found:', id)
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // console.log('[LocalServer] ✅ Found conversation:', JSON.stringify(conversation, null, 2))
      res.json(conversation)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching conversation:', error)
      res.status(500).json({ error: 'Failed to fetch conversation' })
    }
  })

  // DELETE /api/local/conversations/:id
  app.delete('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🗑️ DELETE /api/local/conversations/:id - conversationId:', id)
      statements.deleteConversation.run(id)
      // console.log('[LocalServer] ✅ Conversation deleted:', id)
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error deleting conversation:', error)
      res.status(500).json({ error: 'Failed to delete conversation' })
    }
  })

  // GET /api/local/conversations/:id/messages
  app.get('/api/local/conversations/:id/messages', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 💬 GET /api/local/conversations/:id/messages - conversationId:', id)
      const messages = statements.getMessagesByConversationId.all(id)
      // console.log('[LocalServer] ✅ Found', messages.length, 'messages for conversation:', id)
      // if (messages.length > 0) {
      //   console.log('[LocalServer] 📊 First message:', JSON.stringify(messages[0], null, 2))
      //   console.log('[LocalServer] 📊 Last message:', JSON.stringify(messages[messages.length - 1], null, 2))
      // }
      res.json(messages)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching messages:', error)
      res.status(500).json({ error: 'Failed to fetch messages' })
    }
  })

  // GET /api/local/conversations/:id/messages/top-level-users
  app.get('/api/local/conversations/:id/messages/top-level-users', (req, res) => {
    try {
      const { id } = req.params
      const topLevelUserMessages = statements.getTopLevelUserMessagesByConversationId.all(id)
      res.json(topLevelUserMessages)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching top-level user messages:', error)
      res.status(500).json({ error: 'Failed to fetch top-level user messages' })
    }
  })

  // GET /api/local/conversations/:id/messages/tree
  app.get('/api/local/conversations/:id/messages/tree', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🌲 GET /api/local/conversations/:id/messages/tree - conversationId:', id)
      const messages = statements.getMessagesByConversationId.all(id)
      // console.log('[LocalServer] 📦 Raw messages fetched:', messages.length)

      // Parse JSON fields (children_ids, tool_calls, content_blocks) and fetch attachments
      const normalizedMessages = messages.map((msg: any) => {
        // Fetch attachments for this message
        const attachments = statements.getAttachmentsByMessageId.all(msg.id) as any[]

        return {
          ...msg,
          children_ids: msg.children_ids ? JSON.parse(msg.children_ids) : [],
          tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null,
          content_blocks: msg.content_blocks ? JSON.parse(msg.content_blocks) : null,
          attachments,
          attachments_count: attachments.length,
          has_attachments: attachments.length > 0,
        }
      })

      // console.log('[LocalServer] ✨ Normalized messages:', normalizedMessages.length)
      // if (normalizedMessages.length > 0) {
      //   console.log('[LocalServer] 📊 Sample normalized message:', JSON.stringify(normalizedMessages[0], null, 2))
      // }

      const treeData = buildMessageTree(normalizedMessages)
      // console.log('[LocalServer] 🌳 Tree built successfully:', treeData ? 'Has tree' : 'No tree')
      // if (treeData) {
      //   console.log(
      //     '[LocalServer] 🌳 Tree root:',
      //     JSON.stringify({ id: treeData.id, childCount: treeData.children.length }, null, 2)
      //   )
      // }

      // Get storage_mode from conversation
      const conversation = statements.getConversationById.get(id) as { storage_mode: string } | undefined
      const storage_mode = conversation?.storage_mode || 'local'

      res.json({ messages: normalizedMessages, tree: treeData, meta: { storage_mode } })
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching message tree:', error)
      res.status(500).json({ error: 'Failed to fetch message tree' })
    }
  })

  // POST /api/local/conversations/:id/messages/bulk
  // Bulk insert messages (for copying message chains to new conversation)
  app.post('/api/local/conversations/:id/messages/bulk', (req, res) => {
    try {
      const { id: conversationId } = req.params
      const { messages } = req.body as {
        messages: Array<{
          role: 'user' | 'assistant'
          content: string
          thinking_block?: string
          model_name?: string
          tool_calls?: string
          note?: string
          note_color?: string | null
          content_blocks?: any
        }>
      }

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Messages array required' })
        return
      }

      // Verify conversation exists
      const conversation = statements.getConversationById.get(conversationId) as
        | { user_id: string; title?: string }
        | undefined
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      const createdMessages: any[] = []
      let lastMessageId: string | null = null
      const now = new Date().toISOString()

      // Insert messages sequentially, maintaining parent-child relationships (linear chain)
      for (const msg of messages) {
        const messageId = uuidv4()

        statements.upsertMessage.run(
          messageId,
          conversationId,
          lastMessageId, // Parent is the previous message in the chain
          '[]', // children_ids starts empty (trigger will update parent's children_ids)
          msg.role,
          msg.content,
          msg.content, // plain_text_content
          msg.thinking_block || null,
          msg.tool_calls
            ? typeof msg.tool_calls === 'string'
              ? msg.tool_calls
              : JSON.stringify(msg.tool_calls)
            : null,
          null, // tool_call_id
          msg.model_name || 'unknown',
          msg.note || null,
          msg.note_color || null,
          null, // ex_agent_session_id
          null, // ex_agent_type
          msg.content_blocks
            ? typeof msg.content_blocks === 'string'
              ? msg.content_blocks
              : JSON.stringify(msg.content_blocks)
            : null,
          now
        )

        const createdMessage = {
          id: messageId,
          conversation_id: conversationId,
          parent_id: lastMessageId,
          children_ids: [],
          role: msg.role,
          content: msg.content,
          plain_text_content: msg.content,
          thinking_block: msg.thinking_block || null,
          tool_calls: msg.tool_calls || null,
          model_name: msg.model_name || 'unknown',
          note: msg.note || null,
          note_color: msg.note_color || null,
          content_blocks: msg.content_blocks || null,
          created_at: now,
        }

        createdMessages.push(createdMessage)
        lastMessageId = messageId
      }

      // Auto-generate title if this is the first message chain and title is empty
      if (!conversation.title && messages.length > 0) {
        const firstContent = messages[0].content
        const title = firstContent.slice(0, 100) + (firstContent.length > 100 ? '...' : '')
        statements.updateConversationTitle.run(title, conversationId)
      }

      // Update conversation updated_at timestamp
      if (db) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
      }

      console.log(
        '[LocalServer] ✅ Bulk inserted',
        createdMessages.length,
        'messages into conversation:',
        conversationId
      )
      res.json({ messages: createdMessages })
    } catch (error) {
      console.error('[LocalServer] ❌ Error bulk inserting messages:', error)
      res.status(500).json({ error: 'Failed to bulk insert messages' })
    }
  })

  // PUT /api/local/messages/:id
  app.put('/api/local/messages/:id', (req, res) => {
    try {
      const { id } = req.params
      const { content, note, note_color, content_blocks } = req.body

      // Same logic as server route
      let finalContent = content
      if (!content && content_blocks) {
        const textBlocks = Array.isArray(content_blocks) ? content_blocks.filter((b: any) => b.type === 'text') : []
        finalContent = textBlocks.map((b: any) => b.text || '').join('\n')
      }

      const contentBlocksJson = content_blocks ? JSON.stringify(content_blocks) : null

      // Check if message exists
      const existing = statements.getMessageById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Message not found' })
        return
      }

      // Update message
      statements.updateMessage.run(
        finalContent ?? existing.content,
        note !== undefined ? note : existing.note,
        note_color !== undefined ? note_color : existing.note_color,
        contentBlocksJson ?? existing.content_blocks,
        id
      )

      const updated = statements.getMessageById.get(id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating message:', error)
      res.status(500).json({ error: 'Failed to update message' })
    }
  })

  // DELETE /api/local/messages/:id
  app.delete('/api/local/messages/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🗑️ DELETE /api/local/messages/:id - messageId:', id)
      statements.deleteMessage.run(id)
      // console.log('[LocalServer] ✅ Message deleted:', id)
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error deleting message:', error)
      res.status(500).json({ error: 'Failed to delete message' })
    }
  })

  // POST /api/local/messages/deleteMany - Bulk delete messages
  app.post('/api/local/messages/deleteMany', (req, res) => {
    try {
      const { ids } = req.body
      // console.log('[LocalServer] 🗑️ POST /api/local/messages/deleteMany - ids:', ids)

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids must be a non-empty array' })
        return
      }

      // Delete each message in a transaction
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const deleteTransaction = db.transaction((messageIds: string[]) => {
        for (const id of messageIds) {
          statements.deleteMessage.run(id)
        }
      })

      deleteTransaction(ids)
      // console.log('[LocalServer] ✅ Bulk deleted', ids.length, 'messages')
      res.json({ deleted: ids.length })
    } catch (error) {
      console.error('[LocalServer] ❌ Error bulk deleting messages:', error)
      res.status(500).json({ error: 'Failed to bulk delete messages' })
    }
  })

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

  // GET /api/agents/hermes-session/:conversationId - Get Hermes session info
  app.get('/api/agents/hermes-session/:conversationId', (req, res) => {
    try {
      const { conversationId } = req.params
      const conversation = statements.getConversationById.get(conversationId) as any

      if (!conversation) {
        res.json({ hasSession: false })
        return
      }

      const cwd = conversation.cwd || process.cwd()
      const sessionId = getHermesSession(conversationId, cwd)

      if (sessionId) {
        res.json({
          hasSession: true,
          sessionId,
          cwd,
        })
        return
      }

      const lastHermesMessage = db!
        .prepare(
          `
          SELECT ex_agent_session_id, created_at
          FROM messages
          WHERE conversation_id = ?
            AND ex_agent_session_id IS NOT NULL
            AND ex_agent_session_id != ''
            AND (
              role = 'assistant'
              OR (role = 'ex_agent' AND ex_agent_type = 'hermes_agent')
            )
          ORDER BY created_at DESC
          LIMIT 1
        `
        )
        .get(conversationId) as any

      if (lastHermesMessage?.ex_agent_session_id) {
        setHermesSession(conversationId, cwd, lastHermesMessage.ex_agent_session_id)
      }

      res.json({
        hasSession: !!lastHermesMessage?.ex_agent_session_id,
        sessionId: lastHermesMessage?.ex_agent_session_id,
        lastMessageAt: lastHermesMessage?.created_at,
        cwd,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error getting Hermes session:', error)
      res.status(500).json({ error: 'Failed to get Hermes session' })
    }
  })

  // POST /api/agents/hermes-permission-response/:requestId - Resolve a pending Hermes ACP permission request
  app.post('/api/agents/hermes-permission-response/:requestId', (req, res) => {
    const { requestId } = req.params
    const decisionRaw = typeof req.body?.decision === 'string' ? req.body.decision.trim().toLowerCase() : ''
    const decision: HermesPermissionDecision =
      decisionRaw === 'allow_always' ? 'allow_always' : decisionRaw === 'deny' ? 'deny' : 'allow_once'

    const pending = pendingHermesPermissionRequests.get(requestId)
    if (!pending) {
      res.status(404).json({ error: 'Hermes permission request not found or already resolved' })
      return
    }

    pendingHermesPermissionRequests.delete(requestId)
    pending.resolve(decision)
    res.json({ ok: true })
  })

  // POST /api/agents/hermes-messages/:conversationId - Send message to Hermes ACP backend
  app.post('/api/agents/hermes-messages/:conversationId', async (req, res) => {
    const { conversationId } = req.params
    const {
      message,
      cwd: requestedCwd,
      resume,
      parentId: requestedParentId,
      sessionId: providedSessionId,
      forkSession,
      model,
      maxIterations,
    } = req.body as {
      message: string
      cwd?: string
      resume?: boolean
      parentId?: string | null
      sessionId?: string
      forkSession?: boolean
      model?: string
      maxIterations?: number
    }

    if (!message) {
      res.status(400).json({ error: 'Message content required' })
      return
    }

    const conversation = statements.getConversationById.get(conversationId) as any
    const cwd = requestedCwd || conversation?.cwd || process.cwd()

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const requestAbortController = new AbortController()

    try {
      const lastMessage = statements.getLastMessageByConversationId.get(conversationId) as any
      const parentId = requestedParentId !== undefined ? requestedParentId : lastMessage?.id || null

      const userMsgId = uuidv4()
      const now = new Date().toISOString()
      statements.upsertMessage.run(
        userMsgId,
        conversationId,
        parentId,
        '[]',
        'user',
        message,
        null,
        null,
        null,
        null,
        'user-input',
        null,
        null,
        null,
        null,
        null,
        now
      )

      res.write(
        `data: ${JSON.stringify({ type: 'user_message', message: { id: userMsgId, role: 'user', content: message } })}\n\n`
      )

      const findSessionIdFromAncestorChain = (startMessageId: string | null | undefined): string | undefined => {
        if (!startMessageId) return undefined

        let current = statements.getMessageById.get(startMessageId) as any
        while (current) {
          if (
            typeof current.ex_agent_session_id === 'string' &&
            current.ex_agent_session_id.trim().length > 0 &&
            (current.role === 'assistant' || (current.role === 'ex_agent' && current.ex_agent_type === 'hermes_agent'))
          ) {
            return current.ex_agent_session_id
          }
          if (!current.parent_id) break
          current = statements.getMessageById.get(current.parent_id)
        }

        return undefined
      }

      const lineageSessionId = findSessionIdFromAncestorChain(parentId)
      const executionPlan = resolveHermesExecutionPlan({
        providedSessionId,
        lineageSessionId,
        conversationSessionId: getHermesSession(conversationId, cwd),
        forkSession,
        resume,
      })
      let sessionId = executionPlan.sourceSessionId

      let contentBlocks: any[] = []
      let textParts: string[] = []
      let reasoningParts: string[] = []
      let currentSessionId: string | null = sessionId || null
      let hasPersistedFinalAssistant = false
      let sawHermesContentDelta = false

      const onStream = (data: any) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch (error) {
          console.error('[LocalServer] Error writing Hermes stream data:', error)
        }
      }

      const onStreamingChunk = async (chunk: any) => {
        try {
          // Only forward true token deltas here.
          // Tool lifecycle is streamed via messageType events (tool_start/tool_result).
          if (chunk.type !== 'content_delta' && chunk.type !== 'thinking_delta') {
            return
          }

          if (chunk.type === 'content_delta' && typeof chunk.delta === 'string' && chunk.delta.length > 0) {
            sawHermesContentDelta = true
          }

          if (chunk.type === 'thinking_delta' && typeof chunk.delta === 'string' && chunk.delta.length > 0) {
            reasoningParts.push(chunk.delta)
          }

          res.write(
            `data: ${JSON.stringify({
              type: 'chunk',
              part: chunk.contentType === 'thinking' ? 'reasoning' : 'text',
              delta: chunk.delta || '',
              chunkType: chunk.type,
            })}\n\n`
          )
        } catch (error) {
          console.error('[LocalServer] Error writing Hermes streaming chunk:', error)
        }
      }

      const onResponse = async (response: any) => {
        onStream(response)

        if (response.sessionId) {
          currentSessionId = response.sessionId
          setHermesSession(conversationId, cwd, response.sessionId)
        }

        const event = response.event || {}

        if (response.messageType === 'assistant_message' || response.messageType === 'final') {
          const assistantText =
            (typeof event.content === 'string' && event.content) || (typeof event.text === 'string' && event.text) || ''

          if (assistantText) {
            const isDuplicateFinalText =
              response.messageType === 'final' &&
              textParts.length > 0 &&
              textParts[textParts.length - 1] === assistantText

            if (!isDuplicateFinalText) {
              contentBlocks.push({ type: 'text', text: assistantText })
              textParts.push(assistantText)
              if (!sawHermesContentDelta) {
                res.write(
                  `data: ${JSON.stringify({
                    type: 'chunk',
                    part: 'text',
                    delta: assistantText,
                    chunkType: response.messageType,
                  })}\n\n`
                )
              }
            }
          }
        }

        if (response.messageType === 'tool_start') {
          const toolId = event.tool_call_id || event.toolCallId || uuidv4()
          const toolName = event.name || event.tool_name || 'tool'
          contentBlocks.push({
            type: 'tool_use',
            id: toolId,
            name: toolName,
            input: event.arguments || event.args || {},
          })
        }

        if (response.messageType === 'tool_result') {
          const toolCallId = event.tool_call_id || event.toolCallId || null
          const toolName = event.name || event.tool_name || 'tool'
          const toolContentRaw = event.content ?? event.result ?? ''

          contentBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCallId,
            tool_name: toolName,
            content: toolContentRaw,
            is_error: event.ok === false,
          })
        }

        if (response.messageType === 'error') {
          const errorMessage = response.error?.message || event.message || 'Hermes ACP error'
          if (errorMessage) {
            contentBlocks.push({ type: 'text', text: `[Hermes Error] ${errorMessage}` })
            textParts.push(`[Hermes Error] ${errorMessage}`)
          }
        }

        if (
          response.messageType === 'final' ||
          response.messageType === 'conversation_end' ||
          response.messageType === 'error'
        ) {
          if (!hasPersistedFinalAssistant && contentBlocks.length > 0) {
            if (!currentSessionId) {
              currentSessionId = sessionId || `hermes-${conversationId}`
              setHermesSession(conversationId, cwd, currentSessionId)
            }

            const hermesMsgId = uuidv4()
            const textContent = textParts.join('\n\n').trim()
            const thinkingContent = reasoningParts.join('').trim()

            if (thinkingContent && !contentBlocks.some(block => block?.type === 'thinking')) {
              contentBlocks = [{ type: 'thinking', thinking: thinkingContent }, ...contentBlocks]
            }

            statements.upsertMessage.run(
              hermesMsgId,
              conversationId,
              userMsgId,
              '[]',
              'assistant',
              textContent || '[Hermes response]',
              null,
              null,
              null,
              null,
              model || 'hermes-bridge',
              response.messageType === 'error' ? response.error?.message || event.message || 'Hermes error' : null,
              null,
              currentSessionId,
              null,
              JSON.stringify(normalizeContentBlocksForStorage(contentBlocks)),
              new Date().toISOString()
            )

            res.write(
              `data: ${JSON.stringify({
                type: 'complete',
                sessionId: currentSessionId,
                messageId: hermesMsgId,
                messageCount: contentBlocks.length,
              })}\n\n`
            )

            hasPersistedFinalAssistant = true
          }

          contentBlocks = []
          textParts = []
          reasoningParts = []
        }
      }

      const onPermissionRequest = async (permissionRequest: any): Promise<HermesPermissionDecision> => {
        if (requestAbortController.signal.aborted || res.writableEnded) {
          return 'deny'
        }

        const requestId = uuidv4()
        const toolCall = normalizeHermesPermissionToolCall(permissionRequest)

        res.write(
          `data: ${JSON.stringify({
            type: 'permission_request',
            requestId,
            sessionId: permissionRequest?.sessionId ?? null,
            toolCall,
            options: Array.isArray(permissionRequest?.options) ? permissionRequest.options : [],
          })}\n\n`
        )

        return await new Promise<HermesPermissionDecision>(resolve => {
          let settled = false
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null

          const cleanup = () => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle)
              timeoutHandle = null
            }
            requestAbortController.signal.removeEventListener('abort', onAbort)
            pendingHermesPermissionRequests.delete(requestId)
          }

          const settle = (decision: HermesPermissionDecision) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(decision)
          }

          const onAbort = () => settle('deny')

          pendingHermesPermissionRequests.set(requestId, {
            conversationId,
            createdAt: Date.now(),
            resolve: settle,
          })

          timeoutHandle = setTimeout(() => settle('deny'), HERMES_PERMISSION_RESPONSE_TIMEOUT_MS)
          requestAbortController.signal.addEventListener('abort', onAbort, { once: true })
        })
      }

      const abortHermesRequest = () => {
        if (!requestAbortController.signal.aborted && !res.writableEnded) {
          requestAbortController.abort()
        }
      }

      req.once('aborted', abortHermesRequest)
      res.once('close', abortHermesRequest)

      try {
        await executeHermesAgent(
          conversationId,
          message,
          cwd,
          onResponse,
          onStreamingChunk,
          sessionId,
          forkSession,
          model,
          maxIterations,
          requestAbortController.signal,
          onPermissionRequest
        )
      } finally {
        req.off('aborted', abortHermesRequest)
        res.off('close', abortHermesRequest)
      }

      if (cwd && conversation && conversation.cwd !== cwd) {
        statements.updateConversationCwd.run(cwd, conversationId)
      }
    } catch (error) {
      if (!requestAbortController.signal.aborted && !res.writableEnded) {
        console.error('[LocalServer] Hermes ACP error:', error)
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown Hermes ACP error',
          })}\n\n`
        )
      }
    }

    if (!requestAbortController.signal.aborted && !res.writableEnded) {
      res.end()
    }
  })

  // GET /api/agents/cc-session/:conversationId - Get CC session info
  app.get('/api/agents/cc-session/:conversationId', (req, res) => {
    try {
      const { conversationId } = req.params
      // console.log('[LocalServer] 🤖 GET /api/agents/cc-session/:conversationId -', conversationId)

      // Get conversation to retrieve cwd
      const conversation = statements.getConversationById.get(conversationId) as any
      if (!conversation) {
        res.json({ hasSession: false })
        return
      }

      const cwd = conversation.cwd || process.cwd()
      const sessionId = getSession(conversationId, cwd)

      if (!sessionId) {
        // Also check database for ex_agent messages with session ID
        const lastCCMessage = db!
          .prepare(
            `
          SELECT ex_agent_session_id, created_at 
          FROM messages 
          WHERE conversation_id = ? AND role = 'ex_agent' AND ex_agent_session_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1
        `
          )
          .get(conversationId) as { ex_agent_session_id: string; created_at: string } | undefined

        if (!lastCCMessage?.ex_agent_session_id) {
          res.json({ hasSession: false })
          return
        }

        // Count messages in this session
        const countResult = db!
          .prepare(
            `
          SELECT COUNT(*) as count FROM messages 
          WHERE conversation_id = ? AND ex_agent_session_id = ?
        `
          )
          .get(conversationId, lastCCMessage.ex_agent_session_id) as { count: number }

        res.json({
          hasSession: true,
          sessionId: lastCCMessage.ex_agent_session_id,
          lastMessageAt: lastCCMessage.created_at,
          messageCount: countResult.count,
          cwd: cwd,
        })
        return
      }

      res.json({
        hasSession: true,
        sessionId,
        cwd,
      })
    } catch (error) {
      console.error('[LocalServer] ❌ Error getting CC session:', error)
      res.status(500).json({ error: 'Failed to get CC session' })
    }
  })

  // GET /api/agents/cc-commands/:conversationId - Get available slash commands
  app.get('/api/agents/cc-commands/:conversationId', (req, res) => {
    try {
      const { conversationId } = req.params
      const { cwd: queryCwd } = req.query
      // console.log('[LocalServer] 🤖 GET /api/agents/cc-commands/:conversationId -', conversationId)

      // Get conversation to retrieve cwd if not provided in query
      const conversation = statements.getConversationById.get(conversationId) as any
      const cwd = (queryCwd as string) || conversation?.cwd || process.cwd()

      const commands = getAvailableSlashCommands(conversationId, cwd)
      // console.log(`[LocalServer] Found ${commands.length} slash commands for conversation ${conversationId}`)

      res.json({ commands })
    } catch (error) {
      console.error('[LocalServer] ❌ Error getting CC slash commands:', error)
      res.status(500).json({ error: 'Failed to get slash commands' })
    }
  })

  // POST /api/agents/cc-messages/:conversationId - Send message to Claude Code
  app.post('/api/agents/cc-messages/:conversationId', async (req, res) => {
    // console.log('\n🤖🤖🤖 [LocalServer] POST /api/agents/cc-messages - Claude Code message received')
    // console.log('🤖 Timestamp:', new Date().toISOString())
    // console.log('🤖 Conversation ID:', req.params.conversationId)

    const { conversationId } = req.params
    const {
      message,
      cwd: requestedCwd,
      permissionMode = 'bypassPermissions',
      resume,
      sessionId: providedSessionId,
      forkSession,
    } = req.body as {
      message: string
      cwd?: string
      permissionMode?: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits'
      resume?: boolean
      sessionId?: string
      forkSession?: boolean
    }

    if (!message) {
      res.status(400).json({ error: 'Message content required' })
      return
    }

    // Get conversation to retrieve cwd if not provided
    const conversation = statements.getConversationById.get(conversationId) as any
    const cwd = requestedCwd || conversation?.cwd || process.cwd()

    // console.log('🤖 CC Request:', {
    //   message: message.substring(0, 100),
    //   cwd,
    //   permissionMode,
    //   resume,
    // })

    // Set up SSE for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    try {
      // Get last message for parent ID
      const lastMessage = statements.getLastMessageByConversationId.get(conversationId) as any
      const parentId = lastMessage?.id || null

      // Save user message to local SQLite
      const userMsgId = uuidv4()
      const now = new Date().toISOString()
      statements.upsertMessage.run(
        userMsgId,
        conversationId,
        parentId,
        '[]',
        'user',
        message,
        null,
        null,
        null,
        null,
        'user-input',
        null,
        null,
        null,
        null,
        null,
        now
      )
      // console.log('[LocalServer] 🤖 User message saved:', userMsgId)

      // Send user message event
      res.write(
        `data: ${JSON.stringify({ type: 'user_message', message: { id: userMsgId, role: 'user', content: message } })}\n\n`
      )

      // Determine session ID
      let sessionId = providedSessionId || getSession(conversationId, cwd)
      const shouldResume = resume !== undefined ? resume : !!sessionId

      // Accumulate content blocks for saving
      let contentBlocks: any[] = []
      let textParts: string[] = []
      let currentSessionId: string | null = sessionId || null

      // Stream callback
      const onStream = (data: any) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch (error) {
          console.error('[LocalServer] Error writing stream data:', error)
        }
      }

      // Streaming chunk callback for real-time deltas
      const onStreamingChunk = async (chunk: any) => {
        try {
          res.write(
            `data: ${JSON.stringify({
              type: 'chunk',
              part: chunk.contentType === 'thinking' ? 'reasoning' : 'text',
              delta: chunk.delta || '',
              chunkType: chunk.type,
            })}\n\n`
          )
        } catch (error) {
          console.error('[LocalServer] Error writing streaming chunk:', error)
        }
      }

      // Response callback to accumulate content
      const onResponse = async (response: CCResponse) => {
        onStream(response)

        if (response.sessionId) {
          currentSessionId = response.sessionId
          setSession(conversationId, cwd, response.sessionId)
        }

        // ========================================================================
        // Universal Content Extractor - Capture content from ANY message type
        // ========================================================================

        // Extract text content from any response field
        let extractedContent: string | null = null

        // Priority 1: Check for result.result (slash commands)
        if (response.messageType === 'result' && response.result?.result) {
          extractedContent = response.result.result
          // console.log('[LocalServer] 🔍 Extracted content from result.result:', extractedContent.substring(0, 100))
        }

        // Priority 2: Check for system messages with content
        if (!extractedContent && response.messageType === 'system' && response.system) {
          // Some system messages may contain displayable content
          // Example: init messages with configuration info
          const systemContent = (response.system as any).content || (response.system as any).message
          if (systemContent && typeof systemContent === 'string') {
            extractedContent = systemContent
            // console.log('[LocalServer] 🔍 Extracted content from system message')
          }
        }

        // Priority 3: Check for any 'content' field in the response (catch-all)
        if (!extractedContent && (response as any).content) {
          const genericContent = (response as any).content
          if (typeof genericContent === 'string') {
            extractedContent = genericContent
            // console.log('[LocalServer] 🔍 Extracted content from generic content field')
          } else if (Array.isArray(genericContent)) {
            // If it's an array of blocks, try to extract text
            const textBlocks = genericContent.filter((b: any) => b.type === 'text')
            if (textBlocks.length > 0) {
              extractedContent = textBlocks.map((b: any) => b.text || b.content || '').join('\n')
              // console.log('[LocalServer] 🔍 Extracted content from content blocks array')
            }
          }
        }

        // If we extracted content from a non-message type, add it to contentBlocks
        if (extractedContent && response.messageType !== 'message') {
          const syntheticBlock = {
            type: 'text',
            text: extractedContent,
          }

          contentBlocks.push(syntheticBlock)
          textParts.push(extractedContent)

          // Stream extracted content to frontend immediately
          try {
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk',
                part: 'text',
                delta: extractedContent,
                chunkType: `${response.messageType}_output`,
                sourceMessageType: response.messageType,
              })}\n\n`
            )
          } catch (error) {
            console.error('[LocalServer] Error streaming extracted content:', error)
          }
        }

        // ========================================================================
        // End Universal Content Extractor
        // ========================================================================

        if (response.messageType === 'message' && response.message) {
          for (const block of response.message.content) {
            contentBlocks.push(block)
            if (block.type === 'text') {
              textParts.push((block as any).text || '')
            }
          }
        }

        if (response.messageType === 'result') {
          // Save accumulated CC message to database
          if (contentBlocks.length > 0 && currentSessionId) {
            const ccMsgId = uuidv4()
            const textContent = textParts.join('\n\n').trim()

            statements.upsertMessage.run(
              ccMsgId,
              conversationId,
              userMsgId, // Parent is the user message
              '[]',
              'ex_agent',
              textContent,
              null,
              null, // thinking_block - stored in content_blocks
              null, // tool_calls - stored in content_blocks
              null,
              'claude-sonnet-4-5',
              response.result?.is_error ? 'Generation completed with error' : null,
              null,
              currentSessionId,
              'claude_code',
              JSON.stringify(normalizeContentBlocksForStorage(contentBlocks)),
              new Date().toISOString()
            )
            // console.log('[LocalServer] 🤖 CC message saved:', ccMsgId, '- blocks:', contentBlocks.length)

            // Send complete event
            res.write(
              `data: ${JSON.stringify({
                type: 'complete',
                sessionId: currentSessionId,
                messageId: ccMsgId,
                messageCount: contentBlocks.length,
              })}\n\n`
            )
          }
          // else if (!contentBlocks.length && currentSessionId) {
          //   console.log('[LocalServer] ⚠️ CC result received but no content to save')
          // }

          // Reset accumulators
          contentBlocks = []
          textParts = []
        }

        if (response.messageType === 'error') {
          // Save partial message on error
          if (contentBlocks.length > 0 && currentSessionId) {
            const ccMsgId = uuidv4()
            const textContent = textParts.join('\n\n').trim()

            statements.upsertMessage.run(
              ccMsgId,
              conversationId,
              userMsgId,
              '[]',
              'ex_agent',
              textContent || '[Error during generation]',
              null,
              null,
              null,
              null,
              'claude-sonnet-4-5',
              response.error?.message || 'Error during generation',
              null,
              currentSessionId,
              'claude_code',
              JSON.stringify(normalizeContentBlocksForStorage(contentBlocks)),
              new Date().toISOString()
            )
          }
        }
      }

      // Execute Claude Code
      await executeClaudeCode(
        conversationId,
        message,
        cwd,
        onResponse,
        permissionMode,
        onStreamingChunk,
        shouldResume ? sessionId : undefined,
        forkSession
      )

      // Update conversation cwd if changed
      if (cwd && conversation && conversation.cwd !== cwd) {
        statements.updateConversationCwd.run(cwd, conversationId)
      }

      // console.log('🤖 CC conversation completed successfully')
    } catch (error) {
      console.error('[LocalServer] CC Error:', error)
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })}\n\n`
      )
    }

    res.end()
  })

  // POST /api/agents/cc-messages-branch/:conversationId - Branch message to Claude Code
  app.post('/api/agents/cc-messages-branch/:conversationId', async (req, res) => {
    // console.log('\n🤖🤖🤖 [LocalServer] POST /api/agents/cc-messages-branch - Claude Code branch message received')
    // console.log('🤖 Timestamp:', new Date().toISOString())
    // console.log('🤖 Conversation ID:', req.params.conversationId)

    const { conversationId } = req.params
    const {
      message,
      parentId,
      cwd: requestedCwd,
      permissionMode = 'bypassPermissions',
      sessionId: providedSessionId,
      forkSession,
    } = req.body as {
      message: string
      parentId: string
      cwd?: string
      permissionMode?: 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits'
      sessionId?: string
      forkSession?: boolean
    }

    if (!message) {
      res.status(400).json({ error: 'Message content required' })
      return
    }

    if (parentId === undefined) {
      res.status(400).json({ error: 'parentId is required for branching' })
      return
    }

    const conversation = statements.getConversationById.get(conversationId) as any
    const cwd = requestedCwd || conversation?.cwd || process.cwd()

    // console.log('🤖 CC Branch Request:', {
    //   message: message.substring(0, 100),
    //   parentId,
    //   cwd,
    //   permissionMode,
    // })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    try {
      // Find session ID by walking up the parent chain
      let sessionId = providedSessionId
      if (!sessionId && parentId) {
        let current = statements.getMessageById.get(parentId) as any
        while (current && !sessionId) {
          if (current.role === 'ex_agent' && current.ex_agent_session_id) {
            sessionId = current.ex_agent_session_id
            break
          }
          if (!current.parent_id) break
          current = statements.getMessageById.get(current.parent_id)
        }
      }

      // Save user message
      const userMsgId = uuidv4()
      const now = new Date().toISOString()
      statements.upsertMessage.run(
        userMsgId,
        conversationId,
        parentId,
        '[]',
        'user',
        message,
        null,
        null,
        null,
        null,
        'user-input',
        null,
        null,
        null,
        null,
        null,
        now
      )

      res.write(
        `data: ${JSON.stringify({ type: 'user_message', message: { id: userMsgId, role: 'user', content: message } })}\n\n`
      )

      let contentBlocks: any[] = []
      let textParts: string[] = []
      let currentSessionId: string | null = sessionId || null

      const onStream = (data: any) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch (error) {
          console.error('[LocalServer] Error writing stream data:', error)
        }
      }

      // Streaming chunk callback for real-time deltas
      const onStreamingChunk = async (chunk: any) => {
        try {
          res.write(
            `data: ${JSON.stringify({
              type: 'chunk',
              part: chunk.contentType === 'thinking' ? 'reasoning' : 'text',
              delta: chunk.delta || '',
              chunkType: chunk.type,
            })}\n\n`
          )
        } catch (error) {
          console.error('[LocalServer] Error writing streaming chunk:', error)
        }
      }

      const onResponse = async (response: CCResponse) => {
        onStream(response)

        if (response.sessionId) {
          currentSessionId = response.sessionId
          setSession(conversationId, cwd, response.sessionId)
        }

        // ========================================================================
        // Universal Content Extractor - Capture content from ANY message type
        // ========================================================================

        // Extract text content from any response field
        let extractedContent: string | null = null

        // Priority 1: Check for result.result (slash commands)
        if (response.messageType === 'result' && response.result?.result) {
          extractedContent = response.result.result
          // console.log('[LocalServer] 🔍 Extracted content from result.result:', extractedContent.substring(0, 100))
        }

        // Priority 2: Check for system messages with content
        if (!extractedContent && response.messageType === 'system' && response.system) {
          // Some system messages may contain displayable content
          // Example: init messages with configuration info
          const systemContent = (response.system as any).content || (response.system as any).message
          if (systemContent && typeof systemContent === 'string') {
            extractedContent = systemContent
            // console.log('[LocalServer] 🔍 Extracted content from system message')
          }
        }

        // Priority 3: Check for any 'content' field in the response (catch-all)
        if (!extractedContent && (response as any).content) {
          const genericContent = (response as any).content
          if (typeof genericContent === 'string') {
            extractedContent = genericContent
            // console.log('[LocalServer] 🔍 Extracted content from generic content field')
          } else if (Array.isArray(genericContent)) {
            // If it's an array of blocks, try to extract text
            const textBlocks = genericContent.filter((b: any) => b.type === 'text')
            if (textBlocks.length > 0) {
              extractedContent = textBlocks.map((b: any) => b.text || b.content || '').join('\n')
              // console.log('[LocalServer] 🔍 Extracted content from content blocks array')
            }
          }
        }

        // If we extracted content from a non-message type, add it to contentBlocks
        if (extractedContent && response.messageType !== 'message') {
          const syntheticBlock = {
            type: 'text',
            text: extractedContent,
          }

          contentBlocks.push(syntheticBlock)
          textParts.push(extractedContent)

          // Stream extracted content to frontend immediately
          try {
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk',
                part: 'text',
                delta: extractedContent,
                chunkType: `${response.messageType}_output`,
                sourceMessageType: response.messageType,
              })}\n\n`
            )
          } catch (error) {
            console.error('[LocalServer] Error streaming extracted content:', error)
          }
        }

        // ========================================================================
        // End Universal Content Extractor
        // ========================================================================

        if (response.messageType === 'message' && response.message) {
          for (const block of response.message.content) {
            contentBlocks.push(block)
            if (block.type === 'text') {
              textParts.push((block as any).text || '')
            }
          }
        }

        if (response.messageType === 'result') {
          if (contentBlocks.length > 0 && currentSessionId) {
            const ccMsgId = uuidv4()
            const textContent = textParts.join('\n\n').trim()

            statements.upsertMessage.run(
              ccMsgId,
              conversationId,
              userMsgId,
              '[]',
              'ex_agent',
              textContent,
              null,
              null,
              null,
              null,
              'claude-sonnet-4-5',
              response.result?.is_error ? 'Generation completed with error' : null,
              null,
              currentSessionId,
              'claude_code',
              JSON.stringify(normalizeContentBlocksForStorage(contentBlocks)),
              new Date().toISOString()
            )
            // console.log('[LocalServer] 🤖 CC message saved:', ccMsgId, '- blocks:', contentBlocks.length)

            res.write(
              `data: ${JSON.stringify({
                type: 'complete',
                sessionId: currentSessionId,
                messageId: ccMsgId,
                messageCount: contentBlocks.length,
              })}\n\n`
            )
          }
          // else if (!contentBlocks.length && currentSessionId) {
          //   console.log('[LocalServer] ⚠️ CC result received but no content to save')
          // }

          contentBlocks = []
          textParts = []
        }
      }

      await executeClaudeCode(
        conversationId,
        message,
        cwd,
        onResponse,
        permissionMode,
        onStreamingChunk,
        sessionId,
        forkSession ?? true // Default to fork for branch
      )

      if (cwd && conversation && conversation.cwd !== cwd) {
        statements.updateConversationCwd.run(cwd, conversationId)
      }

      // console.log('🤖 CC branch conversation completed successfully')
    } catch (error) {
      console.error('[LocalServer] CC Branch Error:', error)
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })}\n\n`
      )
    }

    res.end()
  })

  // [Phase 0] Duplicate legacy /api/app/* block removed.
  // Canonical app automation routes are defined earlier in setupServer().

  // Start the OAuth callback server on port 1455
  startOAuthCallbackServer()
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
    initializeLocalDatabase(actualDbPath)

    // Initialize tool registries
    initializeBuiltInToolRegistry()
    await customToolRegistry.initialize()

    utilityRuntimeAvailable = false
    if (getToolRuntimeMode() === 'utility') {
      try {
        const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()
        process.env.YGG_CUSTOM_TOOLS_DIRECTORY = path.dirname(customToolsDir)
      } catch (error) {
        console.warn('[LocalServer] Failed to derive custom tools directory override for utility runtime:', error)
      }

      try {
        await utilityToolRuntimeHost.initialize()
        utilityRuntimeAvailable = true
        console.log('[LocalServer] Utility tool runtime enabled')

        try {
          const syncResult = await utilityToolRuntimeHost.reloadCustomTools('startup_sync')
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
        console.error('[LocalServer] Failed to initialize utility tool runtime; falling back to local tools:', error)
      }
    }
    await skillRegistry.initialize()
    await mcpManager.initialize()

    // Initialize tool orchestrator with database and register tools
    toolOrchestrator.initialize(db!)

    if (utilityRuntimeAvailable) {
      for (const [toolName, handler] of builtInTools.entries()) {
        toolOrchestrator.registerTool(toolName, async (args, options) => {
          if (shouldUseUtilityRuntimeForTool(toolName)) {
            try {
              return await utilityToolRuntimeHost.executeTool(toolName, args, options)
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
            // Convert MCP result to standard ToolResult format
            const textContent = mcpResult.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n')
            return {
              success: !mcpResult.isError,
              content: mcpResult.content,
              text: textContent,
              error: mcpResult.isError ? textContent : undefined,
            }
          } catch (error) {
            console.error(`[LocalServer] MCP tool execution error (${qualifiedName}):`, error)
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        })
      }
      console.log(`[LocalServer] Registered ${mcpTools.length} MCP tools with orchestrator`)
    } catch (error) {
      console.error(`[LocalServer] Error registering MCP tools:`, error)
    }

    setupServer()

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
export function stopLocalServer(): Promise<void> {
  return new Promise(resolve => {
    // Shutdown tool orchestrator first
    toolOrchestrator.shutdown()
    customToolRegistry.shutdown()
    utilityRuntimeAvailable = false
    utilityToolRuntimeHost.shutdown().catch(error => {
      console.error('[LocalServer] Failed to shutdown utility tool runtime:', error)
    })

    // Close OAuth callback server if running
    if (oauthCallbackServer) {
      oauthCallbackServer.close(() => {
        console.log('[OAuthServer] OAuth callback server closed')
      })
      oauthCallbackServer = null
    }

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


