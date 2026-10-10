import { hasFullToolAccess } from '../toolAccessContext.js'
import { StringDecoder } from 'string_decoder'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getManagedToolRoots, isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWSLPath, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'

export interface LineRange {
  startLine: number // 1-based line number to start reading from (inclusive)
  endLine: number // 1-based line number to stop reading at (inclusive)
}

export interface ReadFileOptions {
  maxBytes?: number // safety limit to avoid huge reads; default ~200KB
  startLine?: number // 1-based line number to start reading from (inclusive) - for single range
  endLine?: number // 1-based line number to stop reading at (inclusive) - for single range
  ranges?: LineRange[] // multiple disjoint ranges to read in a single call
  includeHash?: boolean // Calculate content hash for validation (default: false)
  cwd?: string // relative-path base; also the fallback scope for direct callers
  workspaceRoot?: string // trusted runtime scope, separate from the resolution base
  signal?: AbortSignal
  deadlineMs?: number
  // Note: if 'ranges' is provided, startLine/endLine are ignored
}

export interface FileMetadata {
  lineEnding: '\n' | '\r\n' | 'mixed'
  hasBOM: boolean
  encoding: BufferEncoding
  lastModified: Date
  inode?: number // Unix inode number for change detection
}

function isLikelyBinary(buf: Buffer): boolean {
  // Heuristic: if buffer contains many null bytes or non-text control chars
  // within the first chunk, treat as binary
  const len = Math.min(buf.length, 4096)
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const byte = buf[i]
    if (byte === 0) return true
    // allow common control chars: tab(9), lf(10), cr(13)
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / len > 0.3
}

export interface ReadFileResult {
  content: string
  truncated: boolean
  sizeBytes: number
  contentHash?: string // SHA256 hash of returned content for validation
  fileHash?: string // SHA256 hash of entire file when available (requires full-file scan)
  metadata: FileMetadata
  startLine?: number
  endLine?: number
  totalLines?: number
  nextLine?: number // next unread line; repeats the last line if it was only partially returned
  partialLastLine?: boolean
  nextRangeIndex?: number // zero-based range to resume when truncated
  ranges?: Array<{
    startLine: number
    endLine: number
    lineCount: number
  }>
}

/**
 * Calculate SHA256 hash of content
 */
function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Detect line ending style in content
 */
function detectLineEnding(content: string): '\n' | '\r\n' | 'mixed' {
  const hasCRLF = content.includes('\r\n')
  const hasLF = content.includes('\n')
  const lfOnlyCount = (content.match(/(?<!\r)\n/g) || []).length

  if (hasCRLF && lfOnlyCount > 0) return 'mixed'
  if (hasCRLF) return '\r\n'
  if (hasLF) return '\n'
  return '\n' // default for single-line files
}

/**
 * Detect BOM (Byte Order Mark) in buffer
 */
function hasBOM(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

function resolveWslLikeAbsolutePath(inputPath: string, cwd?: string): string {
  const normalizedInput = toWslPath(inputPath)

  if (normalizedInput.startsWith('/')) {
    return path.posix.normalize(normalizedInput)
  }

  const normalizedBase = cwd ? toWslPath(cwd) : toWslPath(process.cwd())
  const basePath = normalizedBase.startsWith('/') ? normalizedBase : path.posix.resolve('/', normalizedBase)

  return path.posix.resolve(basePath, normalizedInput)
}

function assertWithinWorkspace(inputPath: string, resolvedPath: string, cwd: string, usePosix: boolean): void {
  if (usePosix) {
    const workspace = resolveWslLikeAbsolutePath(cwd)
    const target = resolveWslLikeAbsolutePath(resolvedPath)
    const rel = path.posix.relative(workspace, target)

    if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
      const workspaceIsManagedPath = isManagedToolPath(workspace, true)
      const targetIsManagedPath = isManagedToolPath(target, true)
      if (!workspaceIsManagedPath && targetIsManagedPath) {
        return
      }
      throw new Error(
        `Access denied: Path '${inputPath}' resolves to '${resolvedPath}' which is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
      )
    }
    return
  }

  const workspace = path.resolve(cwd)
  const target = path.resolve(resolvedPath)
  const rel = path.relative(workspace, target)

  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const workspaceIsManagedPath = isManagedToolPath(workspace, false)
    const targetIsManagedPath = isManagedToolPath(target, false)
    if (!workspaceIsManagedPath && targetIsManagedPath) {
      return
    }
    throw new Error(
      `Access denied: Path '${inputPath}' resolves to '${resolvedPath}' which is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
    )
  }
}

const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_RANGES = 32

function validateLineRangeValues(options: ReadFileOptions): void {
  const validateLineNumber = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1 (safe integer)`)
    }
  }
  if (options.ranges !== undefined) {
    if (!Array.isArray(options.ranges) || !options.ranges.length || options.ranges.length > MAX_RANGES) {
      throw new Error(`ranges must contain 1 to ${MAX_RANGES} ranges`)
    }
    for (const [i, range] of options.ranges.entries()) {
      if (!range || typeof range !== 'object') throw new Error(`ranges[${i}] must be a line range`)
      validateLineNumber(`ranges[${i}].startLine`, range.startLine)
      validateLineNumber(`ranges[${i}].endLine`, range.endLine)
      if (range.endLine < range.startLine) throw new Error('Range endLine cannot be less than startLine')
    }
    return // ranges take precedence, including over invalid single-range values
  }
  if (options.startLine !== undefined) validateLineNumber('startLine', options.startLine)
  if (options.endLine !== undefined) validateLineNumber('endLine', options.endLine)
  if (options.endLine !== undefined && options.endLine < (options.startLine ?? 1)) {
    throw new Error('endLine cannot be less than startLine')
  }
}

function checkReadCancellation(options: ReadFileOptions): void {
  if (options.signal?.aborted) throw new Error('File read cancelled')
  if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
    throw new Error('File read deadline reached')
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

// Always slice to initialized bytes and keep reading after a short read.
async function readPrefix(fd: fs.promises.FileHandle, limit: number, options: ReadFileOptions): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit)
  let offset = 0
  while (offset < limit) {
    checkReadCancellation(options)
    const { bytesRead } = await fd.read(buffer, offset, limit - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  checkReadCancellation(options)
  return buffer.subarray(0, offset)
}

interface RangeSelection {
  content: string
  endLine?: number
  lineCount: number
  totalLines?: number
  fileHash?: string
  truncated: boolean
  partialLastLine: boolean
  nextLine: number
  lineEndingStyle: FileMetadata['lineEnding']
}

// Scan only new chunks. A single pending CR handles CRLF across chunk boundaries;
// skipped/oversized lines are never accumulated in an unbounded carry string.
async function readRange(
  fd: fs.promises.FileHandle, range: LineRange, maxBytes: number, options: ReadFileOptions
): Promise<RangeSelection> {
  checkReadCancellation(options)
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  const decoder = new StringDecoder('utf8')
  const hasher = options.includeHash ? crypto.createHash('sha256') : undefined
  const parts: string[] = []
  let remaining = maxBytes
  let line = 1
  let endLine: number | undefined
  let lineStarted = false
  let pendingEnding = ''
  let pendingCR = ''
  let sawCRLF = false
  let sawLF = false
  let truncated = false
  let partialLastLine = false
  let stop = false
  let reachedEOF = false

  const append = (text: string): boolean => {
    const value = truncateUtf8(text, remaining)
    if (value) parts.push(value)
    remaining -= Buffer.byteLength(value, 'utf8')
    return value === text
  }
  const fragment = (text: string) => {
    if (line < range.startLine) return
    if (!lineStarted) {
      if (Buffer.byteLength(pendingEnding, 'utf8') > remaining) {
        truncated = true
        stop = true
        return
      }
      append(pendingEnding)
      pendingEnding = ''
      lineStarted = true
    }
    if (!append(text)) {
      truncated = true
      partialLastLine = true
      stop = true
    }
    endLine = line
  }
  const consume = (text: string, final = false) => {
    text = pendingCR + text
    pendingCR = ''
    if (!final && text.endsWith('\r')) {
      pendingCR = '\r'
      text = text.slice(0, -1)
    }
    let offset = 0
    while (!stop) {
      const newline = text.indexOf('\n', offset)
      if (newline === -1) {
        // Do not claim an empty next line at a chunk boundary; EOF handles it.
        if (offset < text.length || final) fragment(text.slice(offset))
        break
      }
      const crlf = newline > offset && text[newline - 1] === '\r'
      if (crlf) sawCRLF = true
      else sawLF = true
      fragment(text.slice(offset, crlf ? newline - 1 : newline))
      if (stop) break
      if (line >= range.endLine) { stop = true; break }
      if (line >= range.startLine) pendingEnding = crlf ? '\r\n' : '\n'
      line++
      lineStarted = false
      offset = newline + 1
    }
  }
  while (!stop) {
    checkReadCancellation(options)
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, position)
    checkReadCancellation(options)
    if (!bytesRead) {
      consume(decoder.end(), true)
      reachedEOF = !truncated
      break
    }
    position += bytesRead
    const chunk = buffer.subarray(0, bytesRead)
    hasher?.update(chunk)
    consume(decoder.write(chunk))
  }
  if (reachedEOF && range.startLine > line) {
    throw new Error(`startLine ${range.startLine} exceeds total lines ${line} in file`)
  }
  return {
    content: parts.join(''), endLine,
    lineCount: endLine === undefined ? 0 : endLine - range.startLine + 1,
    totalLines: reachedEOF ? line : undefined,
    fileHash: reachedEOF ? hasher?.digest('hex') : undefined,
    truncated, partialLastLine,
    nextLine: truncated ? line : (endLine ?? range.startLine - 1) + 1,
    lineEndingStyle: sawCRLF && sawLF ? 'mixed' : sawCRLF ? '\r\n' : '\n',
  }
}

export async function readTextFile(inputPath: string, options: ReadFileOptions = {}): Promise<ReadFileResult> {
  if (typeof inputPath !== 'string' || !inputPath || inputPath.includes('\0')) {
    throw new Error('path must be a non-empty file path without null bytes')
  }
  const maxBytes = options.maxBytes ?? 200 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
    throw new Error(`maxBytes must be an integer between 1 and ${MAX_READ_BYTES}`)
  }
  if (options.includeHash !== undefined && typeof options.includeHash !== 'boolean') {
    throw new Error('includeHash must be a boolean')
  }
  validateLineRangeValues(options)
  checkReadCancellation(options)

  const base = options.cwd || process.cwd()
  const scope = hasFullToolAccess() ? undefined : options.workspaceRoot ?? options.cwd
  const useWsl = isWSLPath(inputPath) || (!path.isAbsolute(inputPath) && isWSLPath(base))
  let abs = useWsl ? resolveWslLikeAbsolutePath(inputPath, base) : path.resolve(base, inputPath)
  if (scope) assertWithinWorkspace(inputPath, abs, scope, useWsl)
  if (useWsl) abs = await resolveToWindowsPath(abs, options)
  checkReadCancellation(options)

  // Check the actual target as well as the lexical path. Read from the canonical
  // path and a single descriptor so metadata/probing/content refer to one file.
  try {
    abs = await fs.promises.realpath(abs)
  } catch {
    throw new Error(`File '${inputPath}' does not exist or is not accessible`)
  }
  if (scope) {
    const nativeScope = isWSLPath(scope) ? await resolveToWindowsPath(scope, options) : scope
    const canonicalScope = await fs.promises.realpath(nativeScope)
    const within = (target: string, root: string) => {
      const rel = path.relative(root, target)
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    }
    let allowed = within(abs, canonicalScope)
    if (!allowed) {
      // Canonicalize the exception roots too (e.g. /var -> /private/var on macOS).
      const managedRoots: string[] = []
      for (const root of getManagedToolRoots(false)) {
        try { managedRoots.push(await fs.promises.realpath(root)) } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
      allowed = !managedRoots.some(root => within(canonicalScope, root)) &&
        managedRoots.some(root => within(abs, root))
    }
    if (!allowed) throw new Error(`Access denied: Path '${inputPath}' resolves outside the workspace '${scope}'`)
  }
  checkReadCancellation(options)
  // Reject directories/devices/FIFOs before opening; fstat repeats the check on
  // the descriptor. O_NOFOLLOW also rejects a last-component symlink swap.
  if (!(await fs.promises.stat(abs)).isFile()) throw new Error(`'${inputPath}' is not a file`)
  checkReadCancellation(options)
  const fd = await fs.promises.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stats = await fd.stat()
    if (!stats.isFile()) throw new Error(`'${inputPath}' is not a file`)
    const probe = await readPrefix(fd, 4096, options)
    if (isLikelyBinary(probe)) throw new Error('Binary file detected; reading binary is not supported by this tool')
    const metadata: FileMetadata = {
      lineEnding: '\n', hasBOM: hasBOM(probe), encoding: 'utf8', lastModified: stats.mtime, inode: stats.ino,
    }
    const needsLines = options.ranges !== undefined || options.startLine !== undefined || options.endLine !== undefined
    if (!needsLines) {
      // A lookahead distinguishes exact-budget EOF from truncation without trusting
      // a stale stat size. StringDecoder avoids flushing an incomplete UTF-8 suffix.
      const buf = await readPrefix(fd, maxBytes + 4, options)
      const decoder = new StringDecoder('utf8')
      const decoded = decoder.write(buf)
      const text = buf.length < maxBytes + 4 ? decoded + decoder.end() : decoded
      const content = truncateUtf8(text, maxBytes)
      const truncated = buf.length > maxBytes || content !== text
      metadata.lineEnding = detectLineEnding(content)
      return {
        content, truncated, sizeBytes: stats.size, metadata,
        contentHash: options.includeHash ? calculateHash(content) : undefined,
        fileHash: options.includeHash && !truncated ? crypto.createHash('sha256').update(buf).digest('hex') : undefined,
      }
    }

    // Process ranges in caller order, preserving overlap/order compatibility and
    // stopping before later ranges once the combined output budget is exhausted.
    const ranges = options.ranges ?? [{ startLine: options.startLine ?? 1, endLine: options.endLine ?? Infinity }]
    const parts: string[] = []
    const rangesInfo: NonNullable<ReadFileResult['ranges']> = []
    let remaining = maxBytes
    let last: RangeSelection | undefined
    let nextRangeIndex: number | undefined
    let sawLF = false
    let sawCRLF = false
    for (const [i, range] of ranges.entries()) {
      if (i) {
        if (remaining < 2) { nextRangeIndex = i; break }
        parts.push('\n\n')
        remaining -= 2
      }
      last = await readRange(fd, range, remaining, options)
      parts.push(last.content)
      remaining -= Buffer.byteLength(last.content, 'utf8')
      rangesInfo.push({ startLine: range.startLine, endLine: last.endLine ?? range.startLine - 1, lineCount: last.lineCount })
      sawLF ||= last.lineEndingStyle !== '\r\n'
      sawCRLF ||= last.lineEndingStyle !== '\n'
      if (last.truncated) { nextRangeIndex = i; break }
    }
    const content = parts.join('')
    metadata.lineEnding = sawLF && sawCRLF ? 'mixed' : sawCRLF ? '\r\n' : '\n'
    const truncated = nextRangeIndex !== undefined
    const nextLine = truncated && nextRangeIndex === rangesInfo.length
      ? ranges[nextRangeIndex].startLine : last!.nextLine
    return {
      content, truncated, sizeBytes: stats.size, metadata,
      contentHash: options.includeHash ? calculateHash(content) : undefined,
      fileHash: truncated ? undefined : last?.fileHash,
      totalLines: last?.totalLines,
      ...(options.ranges ? { ranges: rangesInfo, nextRangeIndex } : {
        startLine: ranges[0].startLine, endLine: last?.endLine,
      }),
      nextLine, partialLastLine: nextRangeIndex === rangesInfo.length ? false : last?.partialLastLine,
    }
  } finally {
    await fd.close()
  }
}

/**
 * Read the next chunk of a file after a given line number.
 * Useful for pagination and avoiding duplicate reads.
 *
 * @param inputPath - File path to read
 * @param afterLine - 1-based line number to start reading after (exclusive)
 * @param numLines - Number of lines to read
 * @param options - Additional read options (maxBytes, etc.)
 * @returns ReadFileResult with the continuation content
 */
export async function readFileContinuation(
  inputPath: string,
  afterLine: number,
  numLines: number,
  options: Omit<ReadFileOptions, 'startLine' | 'endLine' | 'ranges'> & { cwd?: string } = {}
): Promise<ReadFileResult> {
  if (!Number.isSafeInteger(afterLine) || afterLine < 0) {
    throw new Error('afterLine must be >= 0 (use 0 to read from beginning)')
  }
  if (!Number.isSafeInteger(numLines) || numLines < 1 || !Number.isSafeInteger(afterLine + numLines)) {
    throw new Error('numLines must be >= 1')
  }

  const startLine = afterLine + 1
  const endLine = afterLine + numLines

  return readTextFile(inputPath, {
    ...options,
    startLine,
    endLine,
  })
}
