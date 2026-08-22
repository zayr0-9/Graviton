// server/server/builtinToolRegistry.ts
// Server-owned registration of the built-in tool handlers.
//
// Moved out of electron/localServer.ts (Phase 1, Slice 2b) so the tool set is
// owned by the runtime-neutral server graph and both hosts expose one tool
// set minus host-gated entries. This module must not import `electron`:
//   - `browse_web` is the one Electron-only tool. It is registered only when
//     the host supplies a BrowserEngine capability, so a standalone host never
//     advertises a tool it cannot run.
//   - The 26th built-in, `memory_manage`, is a list-only handler registered
//     next to the memory routes in localServer.ts because it closes over them.
//
// Database-backed handlers receive `statements` through accessor functions:
// the SQLite prepared statements are (re)created per server start, after this
// registry is populated.

import { runBashCommand } from './tools/bash.js'
import { runPowerShellCommand } from './tools/powershell.js'
import { braveSearch } from './tools/braveSearch.js'
import { createTextFile } from './tools/createFile.js'
import { type ToolResult } from './tools/customToolLoader.js'
import { execute as executeCustomToolManager } from './tools/customToolManager.js'
import { deleteFile, safeDeleteFile } from './tools/deleteFile.js'
import { extractDirectoryStructure } from './tools/directory.js'
import { editFile, multiEdit } from './tools/editFile.js'
import { execute as executeFetchChats, executeFetchNotes } from './tools/fetchChats.js'
import { execute as executeInternalLink } from './tools/internalLink.js'
import { globSearch } from './tools/glob.js'
import htmlRenderer from './tools/htmlRenderer.js'
import { execute as executeMcpManagerTool } from './tools/mcpManagerTool.js'
import { readFileContinuation, readTextFile } from './tools/readFile.js'
import { formatReadFilesContent, readMultipleTextFiles } from './tools/readFiles.js'
import { ripgrepSearch } from './tools/ripgrep.js'
import { viewImage } from './tools/viewImage.js'
import { execute as executeThemeManager } from './tools/themeManager.js'
import { createTodoList, editTodoList, listTodoLists, readTodoList } from './tools/todoMd.js'
import { executePlanMd } from './tools/planMd.js'
import { recordPreEditBackup, recordToolEditSuccess } from './tools/streamUndoManager.js'
import { execute as executeSkillManager } from './skills/skillManager.js'
import type { BrowserEngine } from './hostCapabilities.js'
import { resolveToolWorkspaceCwd, validateAndResolvePath } from './toolPathPolicy.js'

// Built-in tool handler type
export type BuiltInToolHandler = (
  args: any,
  options: {
    rootPath?: string
    operationMode?: 'plan' | 'execute'
    conversationId?: string | null
    messageId?: string | null
    streamId?: string | null
    parentMessageId?: string | null
    toolCallId?: string | null
  }
) => Promise<ToolResult>

type SearchMessagesFn = (params: {
  userId: string
  query: string
  projectId?: string
  limit: number
}) => Array<Record<string, any>>

export interface BuiltInToolRegistryDeps {
  /** Live accessor for the SQLite prepared statements owned by the server instance. */
  getStatements: () => any
  /** Notes FTS hook, wired by the notes routes after schema init. */
  getSearchNotes: () => SearchMessagesFn | null
  /** Top-level-message FTS hook, wired by the message routes after schema init. */
  getSearchTopLevelUserMessages: () => SearchMessagesFn | null
  /** Host web-page driver. When absent, `browse_web` is not registered. */
  browserEngine?: BrowserEngine
}

/**
 * Populate `builtInTools` with every built-in handler the host can run.
 * Must not clear the map: setupServer() registers `memory_manage` before this
 * runs, and Map.set overwrites make re-registration idempotent anyway.
 */
export function registerBuiltInTools(builtInTools: Map<string, BuiltInToolHandler>, deps: BuiltInToolRegistryDeps): void {
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
    const { paths, baseDir, maxBytes, startLine, endLine, ranges, cwd } = args
    if (!paths) throw new Error('paths are required')
    const effectiveCwd = resolveToolWorkspaceCwd(cwd, rootPath)
    const filesRes = await readMultipleTextFiles(paths, { baseDir, maxBytes, startLine, endLine, ranges, cwd: effectiveCwd })
    const content = formatReadFilesContent(filesRes)
    return { success: true, content, text: content, files: filesRes }
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

  builtInTools.set('edit_file', async (args, options) => {
    const { rootPath, operationMode } = options
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

    const effectiveCwd = rootPath
    const absolutePath = validateAndResolvePath(filePath, effectiveCwd, false)
    if (operationMode === 'execute' && options.streamId) {
      await recordPreEditBackup({
        streamId: options.streamId,
        conversationId: options.conversationId ?? null,
        messageId: options.messageId ?? null,
        parentMessageId: options.parentMessageId ?? null,
        rootPath: rootPath ?? null,
        cwd: effectiveCwd ?? null,
        toolCallId: options.toolCallId ?? null,
        originalPath: filePath,
        absolutePath,
      })
    }

    const result = await editFile(filePath, operation, {
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

    if (operationMode === 'execute' && options.streamId && result?.success && (result.replacements ?? 0) > 0) {
      await recordToolEditSuccess({
        streamId: options.streamId,
        conversationId: options.conversationId ?? null,
        messageId: options.messageId ?? null,
        parentMessageId: options.parentMessageId ?? null,
        rootPath: rootPath ?? null,
        cwd: effectiveCwd ?? null,
        toolCallId: options.toolCallId ?? null,
        originalPath: filePath,
        absolutePath,
        toolName: 'edit_file',
        operation,
      })
      return { ...result, undo: { tracked: true, streamId: options.streamId } }
    }

    return result
  })

  builtInTools.set('multi_edit', async (args, options) => {
    const { rootPath, operationMode } = options
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

    const effectiveCwd = rootPath
    const editPaths = edits
      .map((edit: any, index: number) => ({ edit, index, filePath: typeof edit?.path === 'string' ? edit.path : null }))
      .filter((item: { filePath: string | null }): item is { edit: any; index: number; filePath: string } => Boolean(item.filePath))

    if (operationMode === 'execute' && options.streamId) {
      const seen = new Set<string>()
      for (const item of editPaths) {
        const absolutePath = validateAndResolvePath(item.filePath, effectiveCwd, false)
        if (seen.has(absolutePath)) continue
        seen.add(absolutePath)
        await recordPreEditBackup({
          streamId: options.streamId,
          conversationId: options.conversationId ?? null,
          messageId: options.messageId ?? null,
          parentMessageId: options.parentMessageId ?? null,
          rootPath: rootPath ?? null,
          cwd: effectiveCwd ?? null,
          toolCallId: options.toolCallId ?? null,
          originalPath: item.filePath,
          absolutePath,
        })
      }
    }

    const result = await multiEdit(edits, {
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

    if (operationMode === 'execute' && options.streamId && result?.results) {
      let tracked = 0
      for (const item of result.results) {
        if (!item?.success || (item.replacements ?? 0) <= 0) continue
        const sourceEdit = edits[item.index]
        const originalPath = item.path || sourceEdit?.path
        if (typeof originalPath !== 'string') continue
        const absolutePath = validateAndResolvePath(originalPath, effectiveCwd, false)
        await recordToolEditSuccess({
          streamId: options.streamId,
          conversationId: options.conversationId ?? null,
          messageId: options.messageId ?? null,
          parentMessageId: options.parentMessageId ?? null,
          rootPath: rootPath ?? null,
          cwd: effectiveCwd ?? null,
          toolCallId: options.toolCallId ?? null,
          originalPath,
          absolutePath,
          toolName: 'multi_edit',
          operation: item.operation ?? sourceEdit?.operation ?? null,
          index: item.index,
        })
        tracked += 1
      }
      if (tracked > 0) return { ...result, undo: { tracked: true, streamId: options.streamId, edits: tracked } }
    }

    return result
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

  // Host-gated: `browse_web` drives a real browser window. Register it only
  // when the host supplies an engine, so the advertised tool list never names
  // a tool the host cannot execute.
  if (deps.browserEngine) {
    const browserEngine = deps.browserEngine
    builtInTools.set('browse_web', async args => {
      const { url, ...options } = args
      if (!url) throw new Error('url is required')
      return (await browserEngine.browse(url, options)) as ToolResult
    })
  }

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
    const { action, name, content, search, replacement, edits } = args
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
        if (Array.isArray(edits)) {
          if (edits.length === 0) throw new Error('edits must contain at least one item for todo_list edit')
          for (const [index, edit] of edits.entries()) {
            if (!edit || typeof edit !== 'object') {
              throw new Error(`edits[${index}] must be an object`)
            }
            if (!edit.search) throw new Error(`edits[${index}].search is required for todo_list edit`)
            if (edit.replacement === undefined) {
              throw new Error(`edits[${index}].replacement is required for todo_list edit`)
            }
          }
          const edited = await editTodoList(name, edits)
          return edited
        }
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

  builtInTools.set('plan_md', async (args, { rootPath }) => {
    return await executePlanMd(args, rootPath)
  })

  builtInTools.set('fetch_notes', async (args, options) => {
    const statements = deps.getStatements()
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
        const search = deps.getSearchTopLevelUserMessages()
        if (!search) return []
        return search({ userId, projectId, query, limit })
      },
      searchNotes: ({ userId, projectId, query, limit }) => {
        const search = deps.getSearchNotes()
        if (!search) return []
        return search({ userId, query, projectId, limit })
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
    const statements = deps.getStatements()
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
        const search = deps.getSearchTopLevelUserMessages()
        if (!search) return []
        return search({ userId, projectId, query, limit })
      },
      searchNotes: ({ userId, projectId, query, limit }) => {
        const search = deps.getSearchNotes()
        if (!search) return []
        return search({ userId, query, projectId, limit })
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
    const statements = deps.getStatements()
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
}
