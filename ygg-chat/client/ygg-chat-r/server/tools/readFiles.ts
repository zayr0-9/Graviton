import * as path from 'path'
import { isWSLPath, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'
import { ReadFileOptions, readTextFile } from './readFile.js'

export interface ReadMultipleOptions extends ReadFileOptions {
  baseDir?: string // used to compute the header-relative path separator
  // maxBytes is shared by all formatted file text, headers and separators.
}

export interface ReadMultipleFileResult {
  filename: string
  content: string
  totalLines: number
  success: boolean
  error?: string
  truncated?: boolean
  sizeBytes?: number
  startLine?: number
  endLine?: number
  ranges?: Array<{
    startLine: number
    endLine: number
    lineCount: number
  }>
}

function normalizeForRelativePath(rawPath: string): { normalized: string; usePosix: boolean } {
  const shouldUsePosix = process.platform === 'win32' || isWSLPath(rawPath) || rawPath.startsWith('/')
  return {
    normalized: shouldUsePosix ? toWslPath(rawPath) : path.resolve(rawPath),
    usePosix: shouldUsePosix,
  }
}

function resolveBaseDirForRelativePath(baseDir: string, usePosix: boolean): string {
  if (usePosix) {
    return path.posix.resolve(toWslPath(baseDir))
  }
  return path.resolve(baseDir)
}

function buildRelativeFilename(baseDir: string, absoluteFilePath: string): string {
  const { normalized: fileForRel, usePosix } = normalizeForRelativePath(absoluteFilePath)
  const baseForRel = resolveBaseDirForRelativePath(baseDir, usePosix)
  const pathModule = usePosix ? path.posix : path

  return pathModule.relative(baseForRel, fileForRel).replace(/\\/g, '/')
}

export function normalizeReadFilesMaxBytes(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(5242880, Math.floor(value))) : 204800
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

export function formatReadFilesResult(files: ReadMultipleFileResult[], requestedCount: number) {
  return { success: true, content: formatReadFilesContent(files),
    truncated: files.some(file => file.truncated) || files.length < requestedCount,
    returnedCount: files.length, omittedCount: requestedCount - files.length,
    nextFileIndex: files.length && files[files.length - 1].truncated ? files.length - 1 : files.length }
}

export function formatReadFilesContent(files: ReadMultipleFileResult[]): string {
  return files
    .map(file => {
      const body = file.content
      return `--- ${file.filename} ---\n${body}`
    })
    .join('\n\n')
}

export async function readMultipleTextFiles(
  inputPaths: string[],
  options: ReadMultipleOptions = {}
): Promise<ReadMultipleFileResult[]> {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('No file paths provided')
  }

  // Use cwd for path resolution, falling back to process.cwd()
  const cwdBase = options.cwd || process.cwd()

  const baseDir = options.baseDir
    ? path.isAbsolute(options.baseDir)
      ? options.baseDir
      : path.resolve(cwdBase, options.baseDir)
    : // Default to cwd or current working directory
      cwdBase

  const maxBytes = normalizeReadFilesMaxBytes(options.maxBytes)
  const results: ReadMultipleFileResult[] = []
  let remaining = maxBytes

  // Ordered reads make the shared budget deterministic and stop I/O when it is
  // exhausted, rather than reading every file and discarding the extra output.
  for (const p of inputPaths) {
    let absResolved = p
    if (isWSLPath(p)) absResolved = await resolveToWindowsPath(p)
    else absResolved = path.isAbsolute(p) ? p : path.resolve(cwdBase, p)
    const filename = buildRelativeFilename(baseDir, absResolved)
    const headerBytes = Buffer.byteLength(`${results.length ? '\n\n' : ''}--- ${filename} ---\n`, 'utf8')
    if (remaining <= headerBytes) break
    remaining -= headerBytes
    let result: ReadMultipleFileResult
    try {
      const res = await readTextFile(p, {
        // Probe up to one extra UTF-8 character so the reader cannot decode a
        // budget-boundary prefix as a replacement character before we trim it.
        ...options, maxBytes: remaining + 4, includeHash: false,
      })
      // read_file line/range reads do not apply maxBytes; enforce it here too.
      const content = truncateUtf8(res.content, remaining)
      result = { filename, content, totalLines: res.totalLines ?? res.content.split(/\r?\n/).length,
        success: true, truncated: res.truncated || content !== res.content,
        sizeBytes: res.sizeBytes, startLine: res.startLine, endLine: res.endLine, ranges: res.ranges }
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error)
      const content = truncateUtf8(`[Error reading file: ${message}]`, remaining)
      result = { filename, content, totalLines: 0, success: false, error: message,
        truncated: content !== `[Error reading file: ${message}]` }
    }
    results.push(result)
    remaining -= Buffer.byteLength(result.content, 'utf8')
    if (result.truncated) break
  }
  return results
}
