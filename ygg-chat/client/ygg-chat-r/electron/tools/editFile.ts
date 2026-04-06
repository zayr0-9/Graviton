import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWSLPath, resolveToWindowsPath } from '../utils/wslBridge.js'
import { lspManager } from '../lsp/LspManager.js'
import type { LspFileContext } from '../lsp/types.js'
import { FileMetadata, readTextFile } from './readFile.js'

const FULL_FILE_READ_MAX_BYTES = Number.MAX_SAFE_INTEGER
const DEFAULT_LINE_HINT_WINDOW = 100

export interface EditFileOptions {
  createBackup?: boolean
  encoding?: BufferEncoding
  enableFuzzyMatching?: boolean // Enable layered matching strategies (default: false; fuzzy matching currently disabled)
  fuzzyThreshold?: number // Similarity threshold for fuzzy matching (default: 0.8)
  preserveIndentation?: boolean // Preserve original indentation style (default: true)
  interpretEscapeSequences?: boolean // Deprecated: applies to both search/replacement when specific flags are absent
  interpretSearchEscapes?: boolean // Interpret \n, \t, etc. in search patterns (default: true)
  interpretReplacementEscapes?: boolean // Interpret \n, \t, etc. in replacement text (default: false)
  operationMode?: 'plan' | 'execute'
  validateContent?: boolean // Validate file hasn't changed since read using metadata checks (default: true)
  expectedHash?: string // Optional advisory content hash from previous read; mismatches do not block edits
  expectedMetadata?: FileMetadata // Expected file metadata from previous read
  cwd?: string // Workspace directory for path resolution and restriction
  approxStartLine?: number // Optional approximate start line hint for replace_first windowed matching
  approxEndLine?: number // Optional approximate end line hint for replace_first windowed matching
  lineHintWindow?: number // Optional +/- window size (lines) around hints for replace_first (default: 100)
}

export type EditOperation = 'replace' | 'replace_first' | 'append'

export type MatchStrategy = 'exact' | 'line_ending_normalized' | 'whitespace_normalized' | 'fuzzy'

export interface MatchResult {
  found: boolean
  startIndex: number
  endIndex: number
  matchedText: string
  strategy: MatchStrategy
  similarity?: number // For fuzzy matches
}

export interface FileValidationResult {
  valid: boolean
  reason?: string
  expectedHash?: string
  actualHash?: string
  expectedModified?: Date
  actualModified?: Date
}

export interface EditFileLineInfo {
  oldStartLine: number
  oldEndLine: number
  oldLineCount: number
  newStartLine: number
  newEndLine: number
  newLineCount: number
  scope: 'single' | 'first_of_many' | 'append'
}

export interface EditFileResult {
  success: boolean
  sizeBytes: number
  replacements: number
  message: string
  backup?: string
  matchStrategy?: MatchStrategy // Which strategy succeeded
  attemptedStrategies?: string[] // For debugging failed matches
  validation?: FileValidationResult // Validation result if performed
  lineInfo?: EditFileLineInfo // Real file line metadata for the displayed diff hunk
  lspContext?: LspFileContext
}

export interface MultiEditItem {
  path: string
  operation: EditOperation
  searchPattern?: string
  replacement?: string
  content?: string
  approxStartLine?: number
  approxEndLine?: number
  expectedHash?: string
  expectedMetadata?: FileMetadata
}

export interface MultiEditOptions extends EditFileOptions {
  stopOnError?: boolean
}

export interface MultiEditItemResult extends EditFileResult {
  path: string
  operation?: string
  index: number
}

export interface MultiEditResult {
  success: boolean
  message: string
  results: MultiEditItemResult[]
  applied: number
  failed: number
  stoppedEarly: boolean
}

async function readFullTextFileForEdit(filePath: string, cwd?: string) {
  const fileData = await readTextFile(filePath, {
    cwd,
    maxBytes: FULL_FILE_READ_MAX_BYTES,
    includeHash: false,
  })

  if (fileData.truncated) {
    throw new Error(`Refusing to edit '${filePath}' because the file read was truncated.`)
  }

  return fileData
}

async function resolveLspContextFilePath(filePath: string, cwd?: string): Promise<string | null> {
  if (isWSLPath(filePath) || (cwd && isWSLPath(cwd))) {
    return null
  }

  const basePath = cwd || process.cwd()
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(basePath, filePath)
}

async function collectEditFailureLspContext(filePath: string, cwd?: string): Promise<LspFileContext | undefined> {
  try {
    const resolvedPath = await resolveLspContextFilePath(filePath, cwd)
    if (!resolvedPath) return undefined
    return (await lspManager.collectFileContext(resolvedPath)) || undefined
  } catch {
    return undefined
  }
}

async function enrichEditFileResultWithLspContext(
  result: EditFileResult,
  filePath: string,
  cwd?: string
): Promise<EditFileResult> {
  if (result.success) return result
  const lspContext = await collectEditFailureLspContext(filePath, cwd)
  if (!lspContext) return result
  return {
    ...result,
    lspContext,
  }
}

function resolveEscapeHandling(options: EditFileOptions) {
  const hasLegacyFlag = typeof options.interpretEscapeSequences === 'boolean'
  const legacyValue = options.interpretEscapeSequences ?? true

  return {
    interpretSearchEscapes: options.interpretSearchEscapes ?? (hasLegacyFlag ? legacyValue : true),
    interpretReplacementEscapes: options.interpretReplacementEscapes ?? (hasLegacyFlag ? legacyValue : false),
  }
}

function isManagedPathException(workspacePath: string, targetPath: string, usePosix: boolean): boolean {
  const workspaceIsManagedPath = isManagedToolPath(workspacePath, usePosix)
  const targetIsManagedPath = isManagedToolPath(targetPath, usePosix)
  return !workspaceIsManagedPath && targetIsManagedPath
}

/**
 * Edit a file using simple search and replace operations.
 * Much faster and more context-efficient than AST-based editing.
 *
 * @param filePath - The path to the file to edit
 * @param searchPattern - The text pattern to find
 * @param replacement - The replacement text
 * @param options - Optional settings for the edit operation
 * @returns Promise<EditFileResult>
 */
export async function editFileSearchReplace(
  filePath: string,
  searchPattern: string,
  replacement: string,
  options: EditFileOptions = {}
): Promise<EditFileResult> {
  const {
    encoding = 'utf8',
    enableFuzzyMatching = true,
    fuzzyThreshold = 0.8,
    preserveIndentation = true,
    validateContent = true,
  } = options
  const { interpretSearchEscapes, interpretReplacementEscapes } = resolveEscapeHandling(options)

  try {
    // Resolve path for fs operations and track path type
    let fsPath: string = filePath // Path for fs.promises operations
    let pathType: 'windows' | 'wsl' | 'posix' = 'posix'
    const willBeWsl = isWSLPath(filePath)

    // For WSL paths, resolve to absolute Linux path first (for validation)
    if (willBeWsl) {
      pathType = 'wsl'
      // Make path absolute using POSIX rules (before UNC conversion)
      if (!filePath.startsWith('/')) {
        fsPath = options.cwd ? `${options.cwd.replace(/\/$/, '')}/${filePath}` : filePath
      }
    } else {
      const basePath = options.cwd || process.cwd()
      fsPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
      if (/^[a-zA-Z]:[\\/]/.test(fsPath)) {
        pathType = 'windows'
      }
    }

    // Workspace validation BEFORE UNC conversion (compare Linux to Linux)
    if (options.cwd) {
      if (pathType === 'wsl') {
        // Both are Linux paths - compare directly using POSIX rules
        const normalizedCwd = options.cwd.replace(/\/$/, '')
        const normalizedPath = fsPath.replace(/\/$/, '')
        const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + '/') && normalizedPath !== normalizedCwd
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, true)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      } else {
        // Windows or native paths - use Node's path module
        const normalizedCwd = path.resolve(options.cwd)
        const normalizedPath = path.resolve(fsPath)
        const rel = path.relative(normalizedCwd, normalizedPath)
        const outsideWorkspace = rel.startsWith('..') || path.isAbsolute(rel)
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, false)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      }
    }

    // NOW convert to UNC for filesystem access
    if (pathType === 'wsl') {
      fsPath = await resolveToWindowsPath(fsPath)
    }

    // Read the file first
    const fileData = await readFullTextFileForEdit(filePath, options.cwd)
    const originalContent = fileData.content

    // Validate file content if expected state was provided
    let validation: FileValidationResult | undefined
    if (shouldValidateAgainstExpectations(options, validateContent)) {
      validation = await validateFileContent(fsPath, originalContent, options)
      if (!validation.valid) {
        return await enrichEditFileResultWithLspContext(
          {
            success: false,
            sizeBytes: fileData.sizeBytes,
            replacements: 0,
            message: `Validation failed: ${validation.reason}`,
            validation,
          },
          filePath,
          options.cwd
        )
      }
    }

    // Perform search and replace
    let newContent: string
    let replacements: number
    let matchStrategy: MatchStrategy | undefined
    let attemptedStrategies: string[] = []
    const processedSearchPattern = interpretEscapeSequences(searchPattern, interpretSearchEscapes)

    // Try layered matching strategies
    const matchResult = findMatchWithStrategies(
      originalContent,
      processedSearchPattern,
      enableFuzzyMatching,
      fuzzyThreshold,
      false
    )
    attemptedStrategies = matchResult.attemptedStrategies

    if (!matchResult.found) {
      return await enrichEditFileResultWithLspContext(
        {
          success: false,
          sizeBytes: fileData.sizeBytes,
          replacements: 0,
          message: `Search pattern not found in file. Attempted strategies: ${attemptedStrategies.join(', ')}`,
          attemptedStrategies,
        },
        filePath,
        options.cwd
      )
    }

    matchStrategy = matchResult.strategy

    // Apply indentation preservation if enabled and using non-exact match
    let finalReplacement = replacement
    if (preserveIndentation && matchResult.strategy !== 'exact') {
      const originalIndentation = captureIndentation(matchResult.matchedText)
      finalReplacement = applyIndentation(replacement, originalIndentation)
    }

    // Interpret escape sequences in replacement
    finalReplacement = interpretEscapeSequences(finalReplacement, interpretReplacementEscapes)

    // Keep replacement scope aligned with the strategy that actually matched.
    let lineInfoScope: EditFileLineInfo['scope'] = 'single'
    if (matchResult.strategy === 'exact') {
      const exactRegex = new RegExp(escapeRegExp(processedSearchPattern), 'g')
      const exactMatches = originalContent.match(exactRegex)
      if (!exactMatches || exactMatches.length === 0 || processedSearchPattern === finalReplacement) {
        newContent = originalContent
        replacements = 0
      } else {
        replacements = exactMatches.length
        if (replacements > 1) {
          lineInfoScope = 'first_of_many'
        }
        // Use a replacer function so replacement text is treated literally (no $&/$1 interpolation).
        newContent = originalContent.replace(exactRegex, () => finalReplacement)
      }
    } else {
      if (matchResult.matchedText === finalReplacement) {
        newContent = originalContent
        replacements = 0
      } else {
        replacements = 1
        newContent =
          originalContent.substring(0, matchResult.startIndex) +
          finalReplacement +
          originalContent.substring(matchResult.endIndex)
      }
    }

    const lineInfo = buildLineInfo(
      originalContent,
      matchResult.startIndex,
      matchResult.matchedText,
      finalReplacement,
      lineInfoScope
    )

    const backup = replacements > 0 ? await createBackupIfNeeded(fsPath, originalContent, options, encoding) : undefined

    // Write the modified content back to file
    if (replacements > 0) {
      await fs.promises.writeFile(fsPath, newContent, encoding)
    }

    const strategyMessage =
      matchStrategy && matchStrategy !== 'exact' ? ` (matched using ${matchStrategy} strategy)` : ''

    return {
      success: true,
      sizeBytes: estimateTextSizeBytes(replacements > 0 ? newContent : originalContent, encoding),
      replacements,
      message:
        replacements > 0
          ? `Successfully replaced ${replacements} occurrence(s)${strategyMessage} in ${filePath}`
          : `No changes needed in ${filePath}`,
      backup,
      matchStrategy,
      attemptedStrategies,
      validation,
      lineInfo,
    }
  } catch (error: any) {
    return await enrichEditFileResultWithLspContext(
      {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: `Error editing file: ${error.message}`,
      },
      filePath,
      options.cwd
    )
  }
}

/**
 * Edit a file by replacing the first occurrence of a pattern
 */
export async function editFileSearchReplaceFirst(
  filePath: string,
  searchPattern: string,
  replacement: string,
  options: EditFileOptions = {}
): Promise<EditFileResult> {
  const {
    encoding = 'utf8',
    enableFuzzyMatching = true,
    fuzzyThreshold = 0.8,
    preserveIndentation = true,
    validateContent = true,
    lineHintWindow = DEFAULT_LINE_HINT_WINDOW,
  } = options
  const { interpretSearchEscapes, interpretReplacementEscapes } = resolveEscapeHandling(options)

  try {
    // Resolve path for fs operations and track path type
    let fsPath: string = filePath // Path for fs.promises operations
    let pathType: 'windows' | 'wsl' | 'posix' = 'posix'
    const willBeWsl = isWSLPath(filePath)

    // For WSL paths, resolve to absolute Linux path first (for validation)
    if (willBeWsl) {
      pathType = 'wsl'
      // Make path absolute using POSIX rules (before UNC conversion)
      if (!filePath.startsWith('/')) {
        fsPath = options.cwd ? `${options.cwd.replace(/\/$/, '')}/${filePath}` : filePath
      }
    } else {
      const basePath = options.cwd || process.cwd()
      fsPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
      if (/^[a-zA-Z]:[\\/]/.test(fsPath)) {
        pathType = 'windows'
      }
    }

    // Workspace validation BEFORE UNC conversion (compare Linux to Linux)
    if (options.cwd) {
      if (pathType === 'wsl') {
        // Both are Linux paths - compare directly using POSIX rules
        const normalizedCwd = options.cwd.replace(/\/$/, '')
        const normalizedPath = fsPath.replace(/\/$/, '')
        const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + '/') && normalizedPath !== normalizedCwd
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, true)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      } else {
        // Windows or native paths - use Node's path module
        const normalizedCwd = path.resolve(options.cwd)
        const normalizedPath = path.resolve(fsPath)
        const rel = path.relative(normalizedCwd, normalizedPath)
        const outsideWorkspace = rel.startsWith('..') || path.isAbsolute(rel)
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, false)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      }
    }

    // NOW convert to UNC for filesystem access
    if (pathType === 'wsl') {
      fsPath = await resolveToWindowsPath(fsPath)
    }

    const fileData = await readFullTextFileForEdit(filePath, options.cwd)
    const originalContent = fileData.content

    // Validate file content if expected state was provided
    let validation: FileValidationResult | undefined
    if (shouldValidateAgainstExpectations(options, validateContent)) {
      validation = await validateFileContent(fsPath, originalContent, options)
      if (!validation.valid) {
        return await enrichEditFileResultWithLspContext(
          {
            success: false,
            sizeBytes: fileData.sizeBytes,
            replacements: 0,
            message: `Validation failed: ${validation.reason}`,
            validation,
          },
          filePath,
          options.cwd
        )
      }
    }

    // Try line-hinted matching first for replace_first, then fall back to full-file layered matching.
    const processedSearchPattern = interpretEscapeSequences(searchPattern, interpretSearchEscapes)
    const matchResult = findMatchWithLineHintFallback(
      originalContent,
      processedSearchPattern,
      {
        approxStartLine: options.approxStartLine,
        approxEndLine: options.approxEndLine,
        lineHintWindow,
      },
      enableFuzzyMatching,
      fuzzyThreshold,
      false
    )

    if (!matchResult.found) {
      return await enrichEditFileResultWithLspContext(
        {
          success: false,
          sizeBytes: fileData.sizeBytes,
          replacements: 0,
          message: `Search pattern not found in file. Attempted strategies: ${matchResult.attemptedStrategies.join(', ')}`,
          attemptedStrategies: matchResult.attemptedStrategies,
        },
        filePath,
        options.cwd
      )
    }

    // Apply indentation preservation if enabled and using non-exact match
    let finalReplacement = replacement
    if (preserveIndentation && matchResult.strategy !== 'exact') {
      const originalIndentation = captureIndentation(matchResult.matchedText)
      finalReplacement = applyIndentation(replacement, originalIndentation)
    }

    // Interpret escape sequences in replacement
    finalReplacement = interpretEscapeSequences(finalReplacement, interpretReplacementEscapes)

    const hasChanges = finalReplacement !== matchResult.matchedText
    const newContent = hasChanges
      ? originalContent.substring(0, matchResult.startIndex) +
        finalReplacement +
        originalContent.substring(matchResult.endIndex)
      : originalContent
    const lineInfo = buildLineInfo(
      originalContent,
      matchResult.startIndex,
      matchResult.matchedText,
      finalReplacement,
      'single'
    )

    const backup = hasChanges ? await createBackupIfNeeded(fsPath, originalContent, options, encoding) : undefined

    // Write the modified content if needed
    if (hasChanges) {
      await fs.promises.writeFile(fsPath, newContent, encoding)
    }

    const strategyMessage = matchResult.strategy !== 'exact' ? ` (matched using ${matchResult.strategy} strategy)` : ''

    return {
      success: true,
      sizeBytes: estimateTextSizeBytes(hasChanges ? newContent : originalContent, encoding),
      replacements: hasChanges ? 1 : 0,
      message: hasChanges
        ? `Successfully replaced first occurrence${strategyMessage} in ${filePath}`
        : `No changes needed in ${filePath}`,
      backup,
      matchStrategy: matchResult.strategy,
      attemptedStrategies: matchResult.attemptedStrategies,
      validation,
      lineInfo,
    }
  } catch (error: any) {
    return await enrichEditFileResultWithLspContext(
      {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: `Error editing file: ${error.message}`,
      },
      filePath,
      options.cwd
    )
  }
}

/**
 * Edit a file by appending content to the end
 */
export async function appendToFile(
  filePath: string,
  content: string,
  options: EditFileOptions = {}
): Promise<EditFileResult> {
  const { encoding = 'utf8' } = options

  try {
    // Resolve path for fs operations and track path type
    let fsPath: string = filePath // Path for fs.promises operations
    let pathType: 'windows' | 'wsl' | 'posix' = 'posix'
    const willBeWsl = isWSLPath(filePath)

    // For WSL paths, resolve to absolute Linux path first (for validation)
    if (willBeWsl) {
      pathType = 'wsl'
      // Make path absolute using POSIX rules (before UNC conversion)
      if (!filePath.startsWith('/')) {
        fsPath = options.cwd ? `${options.cwd.replace(/\/$/, '')}/${filePath}` : filePath
      }
    } else {
      const basePath = options.cwd || process.cwd()
      fsPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
      if (/^[a-zA-Z]:[\\/]/.test(fsPath)) {
        pathType = 'windows'
      }
    }

    // Workspace validation BEFORE UNC conversion (compare Linux to Linux)
    if (options.cwd) {
      if (pathType === 'wsl') {
        // Both are Linux paths - compare directly using POSIX rules
        const normalizedCwd = options.cwd.replace(/\/$/, '')
        const normalizedPath = fsPath.replace(/\/$/, '')
        const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + '/') && normalizedPath !== normalizedCwd
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, true)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      } else {
        // Windows or native paths - use Node's path module
        const normalizedCwd = path.resolve(options.cwd)
        const normalizedPath = path.resolve(fsPath)
        const rel = path.relative(normalizedCwd, normalizedPath)
        const outsideWorkspace = rel.startsWith('..') || path.isAbsolute(rel)
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, false)) {
          return {
            success: false,
            sizeBytes: 0,
            replacements: 0,
            message: `Access denied: Path '${filePath}' is outside the workspace '${options.cwd}'. File operations are restricted to the workspace directory.`,
          }
        }
      }
    }

    // NOW convert to UNC for filesystem access
    if (pathType === 'wsl') {
      fsPath = await resolveToWindowsPath(fsPath)
    }

    const existingStats = await fs.promises.stat(fsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })

    const existingContent = existingStats ? await fs.promises.readFile(fsPath, encoding) : ''

    if (existingStats && !existingStats.isFile()) {
      throw new Error(`'${filePath}' is not a file`)
    }

    const backup = existingStats ? await createBackupIfNeeded(fsPath, existingContent, options, encoding) : undefined

    // Append content using fsPath (UNC format on Windows)
    await fs.promises.appendFile(fsPath, content, encoding)

    const previousSizeBytes = existingStats?.size ?? 0
    const appendedSizeBytes = estimateTextSizeBytes(content, encoding)
    const appendStartIndex = existingContent.length
    const lineInfo = buildLineInfo(existingContent, appendStartIndex, '', content, 'append')

    return {
      success: true,
      sizeBytes: previousSizeBytes + appendedSizeBytes,
      replacements: 1, // Consider append as one "replacement"
      message: `Successfully appended content to ${filePath}`,
      backup,
      lineInfo,
    }
  } catch (error: any) {
    return await enrichEditFileResultWithLspContext(
      {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: `Error appending to file: ${error.message}`,
      },
      filePath,
      options.cwd
    )
  }
}

/**
 * Unified edit file function that supports multiple operations
 */
export async function editFile(
  filePath: string,
  operation: EditOperation,
  options: EditFileOptions & {
    searchPattern?: string
    replacement?: string
    content?: string
  } = {}
): Promise<EditFileResult> {
  // Block file editing in plan mode
  if (options.operationMode === 'plan') {
    return {
      success: false,
      sizeBytes: 0,
      replacements: 0,
      message:
        'You are in planning mode. File modification is not allowed. Please describe your implementation plan instead. Do not try to edit the code or make changes. Do not use bash to skip this warning.',
    }
  }

  const { searchPattern, replacement, content } = options

  switch (operation) {
    case 'replace':
      if (!searchPattern || replacement === undefined) {
        return {
          success: false,
          sizeBytes: 0,
          replacements: 0,
          message: 'searchPattern and replacement are required for replace operation',
        }
      }
      return editFileSearchReplace(filePath, searchPattern, replacement, options)

    case 'replace_first':
      if (!searchPattern || replacement === undefined) {
        return {
          success: false,
          sizeBytes: 0,
          replacements: 0,
          message: 'searchPattern and replacement are required for replace_first operation',
        }
      }
      return editFileSearchReplaceFirst(filePath, searchPattern, replacement, options)

    case 'append':
      if (content === undefined) {
        return {
          success: false,
          sizeBytes: 0,
          replacements: 0,
          message: 'content is required for append operation',
        }
      }
      return appendToFile(filePath, content, options)

    default:
      return {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: `Unknown operation: ${operation}`,
      }
  }
}

/**
 * Apply multiple edit_file-style operations sequentially.
 */
export async function multiEdit(
  edits: MultiEditItem[],
  options: MultiEditOptions = {}
): Promise<MultiEditResult> {
  if (options.operationMode === 'plan') {
    return {
      success: false,
      message:
        'You are in planning mode. File modification is not allowed. Please describe your implementation plan instead. Do not try to edit the code or make changes. Do not use bash to skip this warning.',
      results: [],
      applied: 0,
      failed: Array.isArray(edits) ? edits.length : 0,
      stoppedEarly: false,
    }
  }

  if (!Array.isArray(edits) || edits.length === 0) {
    return {
      success: false,
      message: 'edits must be a non-empty array',
      results: [],
      applied: 0,
      failed: 0,
      stoppedEarly: false,
    }
  }

  const stopOnError = options.stopOnError ?? true
  const results: MultiEditItemResult[] = []

  for (const [index, edit] of edits.entries()) {
    const itemPath = typeof edit?.path === 'string' ? edit.path : ''
    const itemOperation = typeof edit?.operation === 'string' ? edit.operation : undefined

    if (!itemPath) {
      const invalidResult: MultiEditItemResult = {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: 'path is required for each multi_edit item',
        path: '',
        operation: itemOperation,
        index,
      }
      results.push(invalidResult)

      if (stopOnError) {
        const applied = results.filter(result => result.success).length
        const failed = results.length - applied
        return {
          success: false,
          message: `Multi-edit stopped after failure at item ${index + 1}.`,
          results,
          applied,
          failed,
          stoppedEarly: index < edits.length - 1,
        }
      }

      continue
    }

    if (!itemOperation) {
      const invalidResult: MultiEditItemResult = {
        success: false,
        sizeBytes: 0,
        replacements: 0,
        message: 'operation is required for each multi_edit item',
        path: itemPath,
        operation: itemOperation,
        index,
      }
      results.push(invalidResult)

      if (stopOnError) {
        const applied = results.filter(result => result.success).length
        const failed = results.length - applied
        return {
          success: false,
          message: `Multi-edit stopped after failure at item ${index + 1} (${itemPath}).`,
          results,
          applied,
          failed,
          stoppedEarly: index < edits.length - 1,
        }
      }

      continue
    }

    const result = await editFile(itemPath, itemOperation as EditOperation, {
      ...options,
      searchPattern: edit.searchPattern,
      replacement: edit.replacement,
      content: edit.content,
      approxStartLine: edit.approxStartLine,
      approxEndLine: edit.approxEndLine,
      expectedHash: edit.expectedHash,
      expectedMetadata: edit.expectedMetadata,
    })

    const itemResult: MultiEditItemResult = {
      ...result,
      path: itemPath,
      operation: itemOperation,
      index,
    }
    results.push(itemResult)

    if (!result.success && stopOnError) {
      const applied = results.filter(item => item.success).length
      const failed = results.length - applied
      return {
        success: false,
        message: `Multi-edit stopped after failure at item ${index + 1} (${itemPath}): ${result.message}`,
        results,
        applied,
        failed,
        stoppedEarly: index < edits.length - 1,
      }
    }
  }

  const applied = results.filter(result => result.success).length
  const failed = results.length - applied

  return {
    success: failed === 0,
    message:
      failed === 0
        ? `Successfully processed ${results.length} multi_edit item(s).`
        : `Processed ${results.length} multi_edit item(s) with ${failed} failure(s).`,
    results,
    applied,
    failed,
    stoppedEarly: false,
  }
}

/**
 * Calculate SHA256 hash of content
 */
function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

function shouldValidateAgainstExpectations(options: EditFileOptions, validateContent: boolean): boolean {
  if (!validateContent) return false

  return Boolean(options.expectedMetadata?.lastModified || options.expectedMetadata?.inode !== undefined)
}

function estimateTextSizeBytes(content: string, encoding: BufferEncoding): number {
  return Buffer.byteLength(content, encoding)
}

async function createBackupIfNeeded(
  absolutePath: string,
  originalContent: string,
  options: EditFileOptions,
  encoding: BufferEncoding
): Promise<string | undefined> {
  if (!options.createBackup) return undefined

  const backupPath = `${absolutePath}.backup.${Date.now()}`
  await fs.promises.writeFile(backupPath, originalContent, encoding)
  return backupPath
}

function countDisplayLines(text: string): number {
  if (text.length === 0) return 0

  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1
    }
  }

  if (text.endsWith('\n')) {
    lines -= 1
  }

  return Math.max(lines, 0)
}

function lineNumberAtIndex(content: string, index: number): number {
  if (content.length === 0) return 1

  const clampedIndex = Math.min(Math.max(index, 0), content.length)
  let line = 1

  for (let i = 0; i < clampedIndex; i++) {
    if (content.charCodeAt(i) === 10) {
      line += 1
    }
  }

  return line
}

function endLineFromStart(startLine: number, lineCount: number): number {
  return lineCount > 0 ? startLine + lineCount - 1 : startLine
}

function buildLineInfo(
  originalContent: string,
  startIndex: number,
  oldText: string,
  newText: string,
  scope: EditFileLineInfo['scope']
): EditFileLineInfo {
  const oldStartLine = lineNumberAtIndex(originalContent, startIndex)
  const oldLineCount = countDisplayLines(oldText)
  const newLineCount = countDisplayLines(newText)
  const newStartLine = oldStartLine

  return {
    oldStartLine,
    oldEndLine: endLineFromStart(oldStartLine, oldLineCount),
    oldLineCount,
    newStartLine,
    newEndLine: endLineFromStart(newStartLine, newLineCount),
    newLineCount,
    scope,
  }
}

interface LineHintBounds {
  approxStartLine?: number
  approxEndLine?: number
  lineHintWindow?: number
}

interface ResolvedLineHintBounds {
  startLine: number
  endLine: number
  startIndex: number
  endIndex: number
}

function coercePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 1) return null
  return rounded
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getLineStartIndex(content: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0

  let currentLine = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      currentLine += 1
      if (currentLine === lineNumber) {
        return i + 1
      }
    }
  }

  return content.length
}

function resolveLineHintBounds(content: string, bounds: LineHintBounds): ResolvedLineHintBounds | null {
  const normalizedStart = coercePositiveInteger(bounds.approxStartLine)
  const normalizedEnd = coercePositiveInteger(bounds.approxEndLine)

  if (!normalizedStart && !normalizedEnd) {
    return null
  }

  const anchorStart = normalizedStart ?? normalizedEnd!
  const anchorEnd = normalizedEnd ?? normalizedStart!
  const orderedStart = Math.min(anchorStart, anchorEnd)
  const orderedEnd = Math.max(anchorStart, anchorEnd)
  const windowSize = Math.max(0, coercePositiveInteger(bounds.lineHintWindow) ?? DEFAULT_LINE_HINT_WINDOW)

  const totalLines = Math.max(1, lineNumberAtIndex(content, content.length))
  const startLine = clamp(orderedStart - windowSize, 1, totalLines)
  const endLine = clamp(orderedEnd + windowSize, startLine, totalLines)

  const startIndex = getLineStartIndex(content, startLine)
  const endIndex = endLine >= totalLines ? content.length : getLineStartIndex(content, endLine + 1)

  return {
    startLine,
    endLine,
    startIndex,
    endIndex,
  }
}

function findMatchWithLineHintFallback(
  content: string,
  pattern: string,
  lineHints: LineHintBounds,
  enableFuzzy: boolean = false,
  fuzzyThreshold: number = 0.8,
  interpretEscapes: boolean = true
): MatchResult & { attemptedStrategies: string[] } {
  const resolvedHints = resolveLineHintBounds(content, lineHints)

  if (!resolvedHints) {
    return findMatchWithStrategies(content, pattern, enableFuzzy, fuzzyThreshold, interpretEscapes)
  }

  const scopedContent = content.slice(resolvedHints.startIndex, resolvedHints.endIndex)
  const scopeLabel = `line_hint_window(${resolvedHints.startLine}-${resolvedHints.endLine})`
  const scopedResult = findMatchWithStrategies(scopedContent, pattern, enableFuzzy, fuzzyThreshold, interpretEscapes)

  if (scopedResult.found) {
    return {
      ...scopedResult,
      startIndex: scopedResult.startIndex + resolvedHints.startIndex,
      endIndex: scopedResult.endIndex + resolvedHints.startIndex,
      attemptedStrategies: scopedResult.attemptedStrategies.map(strategy => `${scopeLabel}:${strategy}`),
    }
  }

  const fallbackResult = findMatchWithStrategies(content, pattern, enableFuzzy, fuzzyThreshold, interpretEscapes)

  return {
    ...fallbackResult,
    attemptedStrategies: [
      ...scopedResult.attemptedStrategies.map(strategy => `${scopeLabel}:${strategy}`),
      `${scopeLabel}:fallback_to_full_file`,
      ...fallbackResult.attemptedStrategies.map(strategy => `full_file:${strategy}`),
    ],
  }
}

/**
 * Validate file content hasn't changed since it was read
 */
async function validateFileContent(
  absolutePath: string,
  content: string,
  options: EditFileOptions
): Promise<FileValidationResult> {
  if (!options.validateContent) {
    return { valid: true }
  }

  const expectedHash = options.expectedHash
  const actualHash = expectedHash ? calculateHash(content) : undefined
  const expectedModified = options.expectedMetadata?.lastModified
  const expectedInode = options.expectedMetadata?.inode

  if (!expectedModified && expectedInode === undefined) {
    return {
      valid: true,
      expectedHash,
      actualHash,
      reason: expectedHash && actualHash !== expectedHash ? 'Content hash mismatch ignored' : undefined,
    }
  }

  const stats = await fs.promises.stat(absolutePath)

  if (expectedInode !== undefined && stats.ino !== expectedInode) {
    return {
      valid: false,
      reason: 'File identity changed (inode mismatch) - file may have been replaced',
    }
  }

  // Check modification time if metadata provided
  if (expectedModified) {
    const expectedTime = new Date(expectedModified).getTime()
    const actualTime = stats.mtime.getTime()

    if (actualTime > expectedTime) {
      return {
        valid: false,
        reason: 'File has been modified since it was read',
        expectedModified,
        actualModified: stats.mtime,
      }
    }
  }

  return { valid: true }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Interpret common escape sequences in a string.
 * Converts literal escape sequences to their actual characters:
 * - \\n → newline
 * - \\r → carriage return
 * - \\t → tab
 * - \\\\ → preserved as literal backslashes
 * - \\' → single quote
 * - \\" → double quote
 *
 * @param str - String potentially containing escape sequences
 * @param enable - Whether to perform interpretation (default: true)
 * @returns String with escape sequences interpreted
 */
function interpretEscapeSequences(str: string, enable: boolean = true): string {
  if (!enable) return str

  const { content: contentWithoutRegexLiterals, protectedLiterals } = protectRegexLiterals(str)

  // Use placeholder to protect literal backslashes (\\)
  const BACKSLASH_PLACEHOLDER = '\u0000LITERAL_BACKSLASH\u0000'

  const interpreted = contentWithoutRegexLiterals
    // First, protect literal backslashes: \\ → placeholder
    .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
    // Then interpret escape sequences
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    // Finally, restore literal backslashes without collapsing them
    .replace(new RegExp(BACKSLASH_PLACEHOLDER, 'g'), '\\\\')

  return restoreProtectedLiterals(interpreted, protectedLiterals)
}

function protectRegexLiterals(str: string): {
  content: string
  protectedLiterals: Array<{ placeholder: string; value: string }>
} {
  const protectedLiterals: Array<{ placeholder: string; value: string }> = []
  let content = ''
  let index = 0

  while (index < str.length) {
    const stringLiteralEnd = findStringLiteralEnd(str, index)
    if (stringLiteralEnd !== -1) {
      const literal = str.slice(index, stringLiteralEnd)
      const placeholder = `\u0000STRING_LITERAL_${protectedLiterals.length}\u0000`
      protectedLiterals.push({ placeholder, value: literal })
      content += placeholder
      index = stringLiteralEnd
      continue
    }

    if (str[index] === '/' && isRegexLiteralStart(str, index)) {
      const regexEnd = findRegexLiteralEnd(str, index + 1)
      if (regexEnd !== -1) {
        let literalEnd = regexEnd + 1

        // Capture regex flags (e.g., /.../gim).
        while (literalEnd < str.length && /[a-z]/i.test(str[literalEnd])) {
          literalEnd += 1
        }

        const literal = str.slice(index, literalEnd)
        const placeholder = `\u0000REGEX_LITERAL_${protectedLiterals.length}\u0000`
        protectedLiterals.push({ placeholder, value: literal })
        content += placeholder
        index = literalEnd
        continue
      }
    }

    content += str[index]
    index += 1
  }

  return { content, protectedLiterals }
}

function findStringLiteralEnd(str: string, startIndex: number): number {
  const quote = str[startIndex]
  if (quote !== "'" && quote !== '"' && quote != '`') {
    return -1
  }

  for (let i = startIndex + 1; i < str.length; i += 1) {
    const ch = str[i]

    if (ch === '\\') {
      i += 1
      continue
    }

    if (ch === quote) {
      return i + 1
    }

    if ((quote === "'" || quote === '"') && (ch === '\n' || ch === '\r')) {
      return -1
    }
  }

  return -1
}

function restoreProtectedLiterals(
  str: string,
  protectedLiterals: Array<{ placeholder: string; value: string }>
): string {
  return protectedLiterals.reduce((output, entry) => output.split(entry.placeholder).join(entry.value), str)
}

function isRegexLiteralStart(str: string, slashIndex: number): boolean {
  // Skip escaped slashes.
  let precedingBackslashes = 0
  for (let i = slashIndex - 1; i >= 0 && str[i] === '\\'; i -= 1) {
    precedingBackslashes += 1
  }
  if (precedingBackslashes % 2 === 1) {
    return false
  }

  // Exclude comment starts.
  const nextChar = str[slashIndex + 1]
  if (nextChar === '/' || nextChar === '*') {
    return false
  }

  // Heuristic: regex literals usually follow operators, delimiters, or start-of-line.
  for (let i = slashIndex - 1; i >= 0; i -= 1) {
    const ch = str[i]
    if (/\s/.test(ch)) continue
    return /[({[=:+\-*%!~?;,|&^<>]/.test(ch)
  }

  return true
}

function findRegexLiteralEnd(str: string, startIndex: number): number {
  let inCharClass = false

  for (let i = startIndex; i < str.length; i += 1) {
    const ch = str[i]

    if (ch === '\n' || ch === '\r') {
      return -1
    }

    if (ch === '\\') {
      i += 1
      continue
    }

    if (ch === '[' && !inCharClass) {
      inCharClass = true
      continue
    }

    if (ch === ']' && inCharClass) {
      inCharClass = false
      continue
    }

    if (ch === '/' && !inCharClass) {
      return i
    }
  }

  return -1
}

/**
 * Normalize line endings to \n
 */
function normalizeLineEndings(str: string): string {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Normalize whitespace by collapsing multiple spaces/tabs to single space
 * and trimming each line
 */
function normalizeWhitespace(str: string): string {
  return str.split('\n').map(normalizeWhitespaceLine).join('\n')
}

function normalizeWhitespaceLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Calculate similarity ratio between two strings (0 to 1)
 */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const distance = levenshteinDistance(a, b)
  const maxLength = Math.max(a.length, b.length)
  return 1 - distance / maxLength
}

/**
 * Find a fuzzy match in content by sliding window
 */
function findFuzzyMatch(
  content: string,
  pattern: string,
  threshold: number = 0.8
): { found: boolean; startIndex: number; endIndex: number; similarity: number; matchedText: string } {
  const normalizedPattern = normalizeWhitespace(pattern)
  const patternLines = normalizedPattern.split('\n').length
  const contentLines = content.split('\n')

  let bestMatch = {
    found: false,
    startIndex: -1,
    endIndex: -1,
    similarity: 0,
    matchedText: '',
  }

  // Slide through content line by line
  for (let i = 0; i <= contentLines.length - patternLines; i++) {
    const candidateLines = contentLines.slice(i, i + patternLines)
    const candidateText = candidateLines.join('\n')
    const normalizedCandidate = normalizeWhitespace(candidateText)

    const similarity = calculateSimilarity(normalizedPattern, normalizedCandidate)

    if (similarity > bestMatch.similarity && similarity >= threshold) {
      // Calculate actual string indices
      const linesBeforeMatch = contentLines.slice(0, i).join('\n')
      const startIndex = linesBeforeMatch.length + (i > 0 ? 1 : 0) // +1 for newline
      const endIndex = startIndex + candidateText.length

      bestMatch = {
        found: true,
        startIndex,
        endIndex,
        similarity,
        matchedText: candidateText,
      }
    }
  }

  return bestMatch
}

/**
 * Capture indentation information from text
 */
function captureIndentation(text: string): string[] {
  return text.split('\n').map(line => {
    const match = line.match(/^(\s*)/)
    return match ? match[1] : ''
  })
}

/**
 * Apply original indentation to replacement text
 */
function applyIndentation(replacement: string, originalIndentation: string[]): string {
  const replacementLines = replacement.split('\n')

  if (replacementLines.length === 0) return replacement
  if (originalIndentation.length === 0) return replacement

  // Get the base indentation from the first line of original
  const baseIndent = originalIndentation[0] || ''

  // Calculate relative indentation in replacement
  const replacementIndents = captureIndentation(replacement)
  const replacementBaseIndent = replacementIndents[0] || ''

  return replacementLines
    .map((line, index) => {
      const lineIndent = replacementIndents[index] || ''
      const trimmedLine = line.trimStart()

      if (trimmedLine === '') return '' // Keep empty lines empty

      // Calculate how much this line is indented relative to the first replacement line
      const relativeIndent =
        lineIndent.length <= replacementBaseIndent.length ? '' : lineIndent.slice(replacementBaseIndent.length)

      // Apply original base indent while preserving tabs/spaces from relative indentation
      const newIndent = baseIndent + relativeIndent
      return newIndent + trimmedLine
    })
    .join('\n')
}

/**
 * Find match using layered strategies
 */
function findMatchWithStrategies(
  content: string,
  pattern: string,
  enableFuzzy: boolean = false,
  fuzzyThreshold: number = 0.8,
  interpretEscapes: boolean = true
): MatchResult & { attemptedStrategies: string[] } {
  const attemptedStrategies: string[] = []

  // Interpret escape sequences in pattern at the start
  const processedPattern = interpretEscapeSequences(pattern, interpretEscapes)

  // Strategy 1: Exact match
  attemptedStrategies.push('exact')
  const exactIndex = content.indexOf(processedPattern)
  if (exactIndex !== -1) {
    return {
      found: true,
      startIndex: exactIndex,
      endIndex: exactIndex + processedPattern.length,
      matchedText: processedPattern,
      strategy: 'exact',
      attemptedStrategies,
    }
  }

  // Strategy 2: Line ending normalized match
  attemptedStrategies.push('line_ending_normalized')
  const normalizedContent = normalizeLineEndings(content)
  const normalizedPattern = normalizeLineEndings(processedPattern)
  const lineEndingIndex = normalizedContent.indexOf(normalizedPattern)
  if (lineEndingIndex !== -1) {
    // Map both normalized start/end indices back to original content.
    const actualStartIndex = mapNormalizedIndexToOriginal(content, lineEndingIndex)
    const actualEndIndex = mapNormalizedIndexToOriginal(content, lineEndingIndex + normalizedPattern.length)
    const matchedText = content.substring(actualStartIndex, actualEndIndex)
    return {
      found: true,
      startIndex: actualStartIndex,
      endIndex: actualEndIndex,
      matchedText,
      strategy: 'line_ending_normalized',
      attemptedStrategies,
    }
  }

  // Strategy 3: Whitespace normalized match
  attemptedStrategies.push('whitespace_normalized')
  const wsNormalizedContent = normalizeWhitespace(normalizedContent)
  const wsNormalizedPattern = normalizeWhitespace(normalizedPattern)
  const wsIndex = wsNormalizedContent.indexOf(wsNormalizedPattern)
  if (wsIndex !== -1) {
    // Find the actual text in original content that matches
    const match = findOriginalTextForNormalizedMatch(content, processedPattern)
    if (match.found) {
      return {
        found: true,
        startIndex: match.startIndex,
        endIndex: match.endIndex,
        matchedText: match.matchedText,
        strategy: 'whitespace_normalized',
        attemptedStrategies,
      }
    }
  }

  // Strategy 4: Fuzzy match
  if (enableFuzzy) {
    attemptedStrategies.push('fuzzy')
    const fuzzyMatch = findFuzzyMatch(content, processedPattern, fuzzyThreshold)
    if (fuzzyMatch.found) {
      return {
        found: true,
        startIndex: fuzzyMatch.startIndex,
        endIndex: fuzzyMatch.endIndex,
        matchedText: fuzzyMatch.matchedText,
        strategy: 'fuzzy',
        similarity: fuzzyMatch.similarity,
        attemptedStrategies,
      }
    }
  }

  return {
    found: false,
    startIndex: -1,
    endIndex: -1,
    matchedText: '',
    strategy: 'exact',
    attemptedStrategies,
  }
}

/**
 * Find actual position in original string given position in normalized string
 */
function mapNormalizedIndexToOriginal(original: string, normalizedIndex: number): number {
  // Simple approach: count characters accounting for \r\n -> \n conversion
  let originalIndex = 0
  let normalizedCount = 0

  while (normalizedCount < normalizedIndex && originalIndex < original.length) {
    if (original[originalIndex] === '\r' && original[originalIndex + 1] === '\n') {
      originalIndex += 2
      normalizedCount += 1
    } else {
      originalIndex += 1
      normalizedCount += 1
    }
  }

  return originalIndex
}

function getLineStartIndices(lines: string[]): number[] {
  const starts: number[] = []
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    starts.push(offset)
    offset += lines[i].length
    if (i < lines.length - 1) {
      offset += 1 // account for normalized \n separator
    }
  }

  return starts
}

/**
 * Find original text that matches a whitespace-normalized pattern
 */
function findOriginalTextForNormalizedMatch(
  content: string,
  pattern: string
): { found: boolean; startIndex: number; endIndex: number; matchedText: string } {
  const normalizedContent = normalizeLineEndings(content)
  const normalizedPattern = normalizeLineEndings(pattern)
  const patternLines = normalizedPattern.split('\n')
  const contentLines = normalizedContent.split('\n')
  const patternNormalizedLines = patternLines.map(normalizeWhitespaceLine)
  const contentLineStarts = getLineStartIndices(contentLines)

  for (let i = 0; i <= contentLines.length - patternLines.length; i++) {
    let matches = true
    for (let j = 0; j < patternLines.length; j++) {
      if (normalizeWhitespaceLine(contentLines[i + j]) !== patternNormalizedLines[j]) {
        matches = false
        break
      }
    }

    if (matches) {
      const normalizedStart = contentLineStarts[i]
      const lastLineIndex = i + patternLines.length - 1
      const normalizedEnd = contentLineStarts[lastLineIndex] + contentLines[lastLineIndex].length
      const startIndex = mapNormalizedIndexToOriginal(content, normalizedStart)
      const endIndex = mapNormalizedIndexToOriginal(content, normalizedEnd)
      const matchedText = content.substring(startIndex, endIndex)

      return { found: true, startIndex, endIndex, matchedText }
    }
  }

  return { found: false, startIndex: -1, endIndex: -1, matchedText: '' }
}

export default editFile
