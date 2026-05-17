import path from 'path'
import { runBashCommand } from './tools/bash.js'
import { runPowerShellCommand } from './tools/powershell.js'
import { createTextFile } from './tools/createFile.js'
import { deleteFile, safeDeleteFile } from './tools/deleteFile.js'
import { extractDirectoryStructure } from './tools/directory.js'
import { editFile, multiEdit } from './tools/editFile.js'
import { globSearch } from './tools/glob.js'
import htmlRenderer from './tools/htmlRenderer.js'
import { readFileContinuation, readTextFile } from './tools/readFile.js'
import { readMultipleTextFiles } from './tools/readFiles.js'
import { ripgrepSearch } from './tools/ripgrep.js'
import { viewImage } from './tools/viewImage.js'
import { customToolRegistry } from './tools/customToolLoader.js'
import type { ToolExecutionOptions, UtilityRuntimeRequest, UtilityRuntimeResponse } from './tools/runtime/protocol.js'
import { isManagedToolPath } from './utils/managedToolPaths.js'

type BuiltInToolHandler = (args: any, options: ToolExecutionOptions) => Promise<any>

const builtInTools: Map<string, BuiltInToolHandler> = new Map()
let customToolsInitialized = false
let customToolsInitPromise: Promise<void> | null = null

function logLifecycle(event: string, details: Record<string, unknown>): void {
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')

  const line = detailText ? `[UtilityToolRuntime] ${event} ${detailText}` : `[UtilityToolRuntime] ${event}`
  console.log(line)
}

function validateAndResolvePath(
  inputPath: string | undefined,
  rootPath: string | undefined,
  fallbackToRoot = true
): string {
  const normalizedInput = typeof inputPath === 'string' ? inputPath.trim() : ''

  if (!normalizedInput) {
    if (fallbackToRoot && rootPath) return rootPath
    return '.'
  }

  const usePosix =
    process.platform === 'win32' &&
    ((typeof inputPath === 'string' && inputPath.startsWith('/')) ||
      (typeof rootPath === 'string' && rootPath.startsWith('/')))

  const pathModule = usePosix ? path.posix : path

  if (!rootPath) {
    return pathModule.resolve(normalizedInput)
  }

  const normalizedRoot = pathModule.resolve(rootPath)
  const resolvedPath = pathModule.isAbsolute(normalizedInput)
    ? pathModule.resolve(normalizedInput)
    : pathModule.resolve(normalizedRoot, normalizedInput)

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

async function ensureCustomToolsInitialized(): Promise<void> {
  if (customToolsInitialized) return
  if (customToolsInitPromise) {
    await customToolsInitPromise
    return
  }

  customToolsInitPromise = (async () => {
    await customToolRegistry.initialize()
    customToolsInitialized = true
  })()

  try {
    await customToolsInitPromise
  } finally {
    customToolsInitPromise = null
  }
}

function initializeBuiltInToolRegistry(): void {
  builtInTools.set('html_renderer', async args => {
    const { html, allowUnsafe } = args
    if (!html) throw new Error('html is required')
    return await htmlRenderer.run({ html, allowUnsafe })
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
}

function postMessage(message: UtilityRuntimeResponse): void {
  ;(process as any).parentPort?.postMessage(message)
}

function normalizeIncomingMessage(raw: unknown): UtilityRuntimeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as any
  if (candidate.type) return candidate as UtilityRuntimeRequest
  if (candidate.data && typeof candidate.data === 'object' && candidate.data.type) {
    return candidate.data as UtilityRuntimeRequest
  }
  return null
}

async function reloadCustomTools(requestId: string, reason: string | undefined): Promise<void> {
  const startedAtMs = Date.now()
  try {
    await ensureCustomToolsInitialized()
    await customToolRegistry.reload(`utility_host:${reason || 'manual'}`)
    const durationMs = Date.now() - startedAtMs
    postMessage({
      type: 'custom_tools_reloaded',
      requestId,
      success: true,
      totalCount: customToolRegistry.getToolCount(),
      durationMs,
    })
    logLifecycle('custom_tools_reloaded', { requestId, durationMs, reason, totalCount: customToolRegistry.getToolCount() })
  } catch (error) {
    const durationMs = Date.now() - startedAtMs
    const msg = error instanceof Error ? error.message : String(error)
    postMessage({
      type: 'custom_tools_reloaded',
      requestId,
      success: false,
      error: msg,
      durationMs,
    })
    logLifecycle('custom_tools_reload_failed', { requestId, durationMs, reason, error: msg })
  }
}

async function handleRequest(message: UtilityRuntimeRequest): Promise<void> {
  if (message.type === 'shutdown') {
    postMessage({ type: 'shutdown_ack', requestId: message.requestId })
    process.exit(0)
  }

  if (message.type === 'reload_custom_tools') {
    await reloadCustomTools(message.requestId, message.reason)
    return
  }

  if (message.type !== 'execute_tool') {
    return
  }

  const startedAtMs = Date.now()
  const handler = builtInTools.get(message.toolName)

  logLifecycle('request_start', {
    requestId: message.requestId,
    toolName: message.toolName,
  })

  try {
    if (handler) {
      const result = await handler(message.args, message.options || {})
      const durationMs = Date.now() - startedAtMs
      postMessage({
        type: 'tool_result',
        requestId: message.requestId,
        success: true,
        result,
        telemetry: { durationMs, handledBy: 'built_in' },
      })
      logLifecycle('request_success', {
        requestId: message.requestId,
        toolName: message.toolName,
        durationMs,
        handledBy: 'built_in',
      })
      return
    }

    await ensureCustomToolsInitialized()

    if (customToolRegistry.hasCustomTool(message.toolName)) {
      const result = await customToolRegistry.executeTool(message.toolName, message.args, {
        rootPath: message.options?.rootPath,
        operationMode: message.options?.operationMode,
        conversationId: message.options?.conversationId,
        messageId: message.options?.messageId,
        streamId: message.options?.streamId,
        cwd: message.options?.rootPath,
      })
      const durationMs = Date.now() - startedAtMs
      postMessage({
        type: 'tool_result',
        requestId: message.requestId,
        success: true,
        result,
        telemetry: { durationMs, handledBy: 'custom' },
      })
      logLifecycle('request_success', {
        requestId: message.requestId,
        toolName: message.toolName,
        durationMs,
        handledBy: 'custom',
      })
      return
    }

    const durationMs = Date.now() - startedAtMs
    postMessage({
      type: 'tool_result',
      requestId: message.requestId,
      success: false,
      error: `Unsupported tool in utility runtime: ${message.toolName}`,
      errorCode: 'unsupported_tool',
      telemetry: { durationMs },
    })
    logLifecycle('request_unsupported_tool', {
      requestId: message.requestId,
      toolName: message.toolName,
      durationMs,
    })
  } catch (error) {
    const durationMs = Date.now() - startedAtMs
    const msg = error instanceof Error ? error.message : String(error)
    postMessage({
      type: 'tool_result',
      requestId: message.requestId,
      success: false,
      error: msg,
      errorCode: 'execution_error',
      telemetry: { durationMs, handledBy: handler ? 'built_in' : 'custom' },
    })
    logLifecycle('request_error', {
      requestId: message.requestId,
      toolName: message.toolName,
      durationMs,
      error: msg,
    })
  }
}

async function bootstrap(): Promise<void> {
  initializeBuiltInToolRegistry()

  const parentPort = (process as any).parentPort
  if (!parentPort || typeof parentPort.on !== 'function') {
    throw new Error('Utility runtime parent port is unavailable')
  }

  parentPort.on('message', (rawMessage: unknown) => {
    const message = normalizeIncomingMessage(rawMessage)
    if (!message) {
      return
    }
    void handleRequest(message)
  })

  try {
    await ensureCustomToolsInitialized()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[UtilityToolRuntime] Failed to initialize custom tools at startup:', msg)
  }

  postMessage({ type: 'ready' })
}

void bootstrap().catch(error => {
  const msg = error instanceof Error ? error.stack || error.message : String(error)
  console.error('[UtilityToolRuntime] Fatal bootstrap error:', msg)
  process.exit(1)
})
