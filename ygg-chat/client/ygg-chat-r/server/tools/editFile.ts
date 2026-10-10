import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { isWSLPath } from '../utils/wslBridge.js'
import { withEditTarget } from './editFileIO.js'
import { lspManager } from '../lsp/LspManager.js'
import type { LspFileContext } from '../lsp/types.js'
import type { FileMetadata } from './readFile.js'

const batchVersions = Symbol('batchVersions')
const batchTargets = Symbol('batchTargets')
const DEFAULT_LINE_HINT_WINDOW = 100

export interface EditFileOptions {
  [batchVersions]?: Map<string, fs.Stats>
  [batchTargets]?: Map<string, string>
  beforeWrite?: (absolutePath: string, originalPath: string) => Promise<void> // Runtime undo hook; never model supplied
  createBackup?: boolean
  encoding?: BufferEncoding
  enableFuzzyMatching?: boolean // Opt-in bounded fuzzy matching (default: false)
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
  skipLastModifiedValidation?: boolean // Skip mtime validation while still allowing inode validation (used by multi_edit sequential edits)
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
    enableFuzzyMatching = false,
    fuzzyThreshold = 0.8,
    preserveIndentation = true,
    validateContent = true,
  } = options
  const { interpretSearchEscapes, interpretReplacementEscapes } = resolveEscapeHandling(options)

  try {
    if (typeof searchPattern !== 'string' || !searchPattern || typeof replacement !== 'string') {
      throw new Error('A non-empty searchPattern and string replacement are required')
    }
    return await withEditTarget(filePath, { ...options, allowCreate: false, versions: options[batchVersions], targets: options[batchTargets] }, async target => {

    // Read the file first
    const fileData = target
    const originalContent = fileData.content

    // Validate file content if expected state was provided
    let validation: FileValidationResult | undefined
    if (shouldValidateAgainstExpectations(options, validateContent)) {
      validation = validateFileContent(target.stats, originalContent, { ...options, skipLastModifiedValidation: target.previouslyEdited || options.skipLastModifiedValidation })
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
    if (preserveIndentation && (matchResult.strategy === 'whitespace_normalized' || matchResult.strategy === 'fuzzy')) {
      const originalIndentation = captureIndentation(matchResult.matchedText)
      finalReplacement = applyIndentation(replacement, originalIndentation)
    }

    // Interpret escape sequences in replacement
    finalReplacement = interpretEscapeSequences(finalReplacement, interpretReplacementEscapes)

    // Keep replacement scope aligned with the strategy that actually matched.
    let lineInfoScope: EditFileLineInfo['scope'] = 'single'
    if (matchResult.strategy === 'exact') {
      const exactRegex = new RegExp(escapeRegExp(processedSearchPattern), 'g')
      if (processedSearchPattern === finalReplacement) {
        newContent = originalContent
        replacements = 0
      } else {
        replacements = 0
        // Count and replace in one pass; keep replacement text literal.
        newContent = originalContent.replace(exactRegex, () => { replacements++; return finalReplacement })
        if (replacements > 1) lineInfoScope = 'first_of_many'
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

    const backup = replacements > 0 && options.createBackup ? await target.backup() : undefined

    // Write the modified content back to file
    if (replacements > 0) {
      await target.write(newContent)
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
    })
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
    enableFuzzyMatching = false,
    fuzzyThreshold = 0.8,
    preserveIndentation = true,
    validateContent = true,
    lineHintWindow = DEFAULT_LINE_HINT_WINDOW,
  } = options
  const { interpretSearchEscapes, interpretReplacementEscapes } = resolveEscapeHandling(options)

  try {
    if (typeof searchPattern !== 'string' || !searchPattern || typeof replacement !== 'string') {
      throw new Error('A non-empty searchPattern and string replacement are required')
    }
    return await withEditTarget(filePath, { ...options, allowCreate: false, versions: options[batchVersions], targets: options[batchTargets] }, async target => {

    const fileData = target
    const originalContent = fileData.content

    // Validate file content if expected state was provided
    let validation: FileValidationResult | undefined
    if (shouldValidateAgainstExpectations(options, validateContent)) {
      validation = validateFileContent(target.stats, originalContent, { ...options, skipLastModifiedValidation: target.previouslyEdited || options.skipLastModifiedValidation })
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
    if (preserveIndentation && (matchResult.strategy === 'whitespace_normalized' || matchResult.strategy === 'fuzzy')) {
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

    const backup = hasChanges && options.createBackup ? await target.backup() : undefined

    // Write the modified content if needed
    if (hasChanges) {
      await target.write(newContent)
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
    })
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
    return await withEditTarget(filePath, { ...options, allowCreate: true, versions: options[batchVersions], targets: options[batchTargets] }, async target => {
    const existingStats = target.stats
    const existingContent = target.content
    let validation: FileValidationResult | undefined
    if (shouldValidateAgainstExpectations(options, options.validateContent !== false)) {
      validation = validateFileContent(existingStats, existingContent, { ...options, skipLastModifiedValidation: target.previouslyEdited || options.skipLastModifiedValidation })
      if (!validation.valid) return { success: false, sizeBytes: target.sizeBytes, replacements: 0, message: `Validation failed: ${validation.reason}`, validation }
    }
    const backup = existingStats && options.createBackup ? await target.backup() : undefined
    await target.write(content, true)

    const previousSizeBytes = existingStats?.size ?? 0
    const appendedSizeBytes = estimateTextSizeBytes(content, encoding)
    const appendStartIndex = existingContent.length
    const lineInfo = buildLineInfo(existingContent, appendStartIndex, '', content, 'append')

    return {
      success: true,
      sizeBytes: previousSizeBytes + appendedSizeBytes,
      replacements: 1, // Consider append as one "replacement"
      message: `Successfully appended content to ${filePath}`,
      validation,
      backup,
      lineInfo,
    }
    })
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
  const versions = new Map<string, fs.Stats>()
  const targets = new Map<string, string>()

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
      [batchVersions]: versions,
      [batchTargets]: targets,
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

  if (options.skipLastModifiedValidation) {
    return options.expectedMetadata?.inode !== undefined
  }

  return Boolean(options.expectedMetadata?.lastModified || options.expectedMetadata?.inode !== undefined)
}

function estimateTextSizeBytes(content: string, encoding: BufferEncoding): number {
  return Buffer.byteLength(content, encoding)
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
  const windowSize = bounds.lineHintWindow === 0 ? 0 : coercePositiveInteger(bounds.lineHintWindow) ?? DEFAULT_LINE_HINT_WINDOW

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
  const processedPattern = interpretEscapeSequences(pattern, interpretEscapes)
  // Preserve the cheap local exact path; an approximate hint must not outrank
  // an exact match elsewhere with a normalized or fuzzy candidate.
  const localExact = scopedContent.indexOf(processedPattern)
  const globalExact = localExact === -1 ? content.indexOf(processedPattern) : -1
  if (globalExact !== -1) {
    return {
      found: true, startIndex: globalExact, endIndex: globalExact + processedPattern.length,
      matchedText: processedPattern, strategy: 'exact',
      attemptedStrategies: [`${scopeLabel}:exact`, `${scopeLabel}:fallback_to_full_file`, 'full_file:exact'],
    }
  }
  const scopedResult = findMatchWithStrategies(scopedContent, processedPattern, false, fuzzyThreshold, false)

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
function validateFileContent(
  stats: fs.Stats | null,
  content: string,
  options: EditFileOptions
): FileValidationResult {
  if (options.validateContent === false) {
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

  if (!stats) return { valid: false, reason: 'Previously read file no longer exists' }

  if (expectedInode !== undefined && stats.ino !== expectedInode) {
    return {
      valid: false,
      reason: 'File identity changed (inode mismatch) - file may have been replaced',
    }
  }

  // Check modification time if metadata provided
  if (expectedModified && !options.skipLastModifiedValidation) {
    const expectedTime = new Date(expectedModified).getTime()
    const actualTime = stats.mtime.getTime()

    if (!Number.isFinite(expectedTime) || actualTime !== expectedTime) {
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
  if (!protectedLiterals.length) return str
  // One pass, not a full-string split/join for every literal on minified lines.
  const literals = new Map(protectedLiterals.map(entry => [entry.placeholder, entry.value]))
  return str.replace(/\u0000(?:STRING|REGEX)_LITERAL_\d+\u0000/g, placeholder => literals.get(placeholder) ?? placeholder)
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
  // Fast path for ordinary lines; only tokenize lines that contain literal delimiters.
  if (!/["'`/]/.test(line)) return line.trim().replace(/[ \t]+/g, ' ')
  // Never collapse meaningful spaces inside string/regex literals.
  const protectedText = protectRegexLiterals(line)
  return restoreProtectedLiterals(protectedText.content.trim().replace(/[ \t]+/g, ' '), protectedText.protectedLiterals)
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  // Two typed rows instead of an O(m*n) heap of arrays.
  let previous = new Uint32Array(a.length + 1)
  let current = new Uint32Array(a.length + 1)
  for (let j = 0; j <= a.length; j++) previous[j] = j
  for (let i = 1; i <= b.length; i++) {
    current[0] = i
    for (let j = 1; j <= a.length; j++) {
      current[j] = Math.min(previous[j - 1] + (b.charCodeAt(i - 1) === a.charCodeAt(j - 1) ? 0 : 1), previous[j] + 1, current[j - 1] + 1)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[a.length]
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

  // A deterministic total work budget bounds event-loop blocking. If exhausted,
  // fail closed rather than accepting a candidate from an incomplete search.
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1 || normalizedPattern.length > 4096) return bestMatch
  let remainingCells = 2_000_000
  const starts = getLineStartIndices(contentLines)
  let ambiguous = false
  for (let i = 0; i <= contentLines.length - patternLines; i++) {
    const candidateLines = contentLines.slice(i, i + patternLines)
    const candidateText = candidateLines.join('\n')
    const normalizedCandidate = normalizeWhitespace(candidateText)

    const maxLength = Math.max(normalizedPattern.length, normalizedCandidate.length)
    if (Math.abs(normalizedPattern.length - normalizedCandidate.length) > (1 - threshold) * maxLength) continue
    remainingCells -= normalizedPattern.length * normalizedCandidate.length
    if (remainingCells < 0) return { found: false, startIndex: -1, endIndex: -1, similarity: 0, matchedText: '' }
    const similarity = calculateSimilarity(normalizedPattern, normalizedCandidate)
    if (similarity === bestMatch.similarity && similarity >= threshold) ambiguous = true
    if (similarity > bestMatch.similarity && similarity >= threshold) {
      ambiguous = false
      const startIndex = starts[i]
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

  return ambiguous ? { ...bestMatch, found: false } : bestMatch
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
      const delta = lineIndent.length - replacementBaseIndent.length
      const newIndent = delta < 0
        ? baseIndent.slice(0, Math.max(0, baseIndent.length + delta))
        : baseIndent + lineIndent.slice(replacementBaseIndent.length)
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
