import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { isManagedToolPath } from '../utils/managedToolPaths.js'
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
  cwd?: string // workspace directory for path resolution and restriction
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

    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
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

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
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

function validateLineRangeValues(options: ReadFileOptions): void {
  const validateLineNumber = (name: string, value: number) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1`)
    }
  }

  if (options.startLine !== undefined) {
    validateLineNumber('startLine', options.startLine)
  }
  if (options.endLine !== undefined) {
    validateLineNumber('endLine', options.endLine)
  }

  if (options.ranges) {
    for (let i = 0; i < options.ranges.length; i++) {
      const range = options.ranges[i]
      validateLineNumber(`ranges[${i}].startLine`, range.startLine)
      validateLineNumber(`ranges[${i}].endLine`, range.endLine)
    }
  }
}

interface StreamedLineSelectionResult {
  content: string
  totalLines?: number
  startLine?: number
  endLine?: number
  ranges?: Array<{
    startLine: number
    endLine: number
    lineCount: number
  }>
  lineEndingStyle: '\n' | '\r\n' | 'mixed'
  fileHash?: string
}

async function readProbeBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const bytesToRead = Math.max(0, maxBytes)
  if (bytesToRead === 0) {
    return Buffer.alloc(0)
  }

  const fd = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await fd.read(buf, 0, bytesToRead, 0)
    return bytesRead === bytesToRead ? buf : buf.subarray(0, bytesRead)
  } finally {
    await fd.close()
  }
}

async function readLineSelectionFromFile(
  filePath: string,
  options: ReadFileOptions,
  includeHash: boolean
): Promise<StreamedLineSelectionResult> {
  const hasRanges = !!options.ranges && options.ranges.length > 0
  const requestedRanges =
    options.ranges?.map(range => {
      const startLine = Math.max(1, range.startLine)
      const endLine = range.endLine
      if (endLine < startLine) {
        throw new Error(`Range endLine ${endLine} cannot be less than startLine ${startLine}`)
      }
      return {
        startLine,
        endLine,
        lines: [] as string[],
      }
    }) || []

  const singleStartLine = options.startLine !== undefined ? Math.max(1, options.startLine) : 1
  const singleEndLine = options.endLine ?? Number.POSITIVE_INFINITY
  if (!hasRanges && Number.isFinite(singleEndLine) && singleEndLine < singleStartLine) {
    throw new Error(`endLine ${singleEndLine} cannot be less than startLine ${singleStartLine}`)
  }

  const maxRequestedEndLine = hasRanges
    ? Math.max(...requestedRanges.map(range => range.endLine))
    : Number.isFinite(singleEndLine)
      ? singleEndLine
      : Number.POSITIVE_INFINITY

  let lineNumber = 0
  let carry = ''
  let endedWithLineBreak = false
  let reachedEOF = false
  let stoppedEarly = false

  let sawCRLF = false
  let sawLFOnly = false

  const selectedLines: string[] = []

  const wholeFileHasher = includeHash ? crypto.createHash('sha256') : null

  const processLine = (line: string) => {
    lineNumber += 1

    if (hasRanges) {
      for (const range of requestedRanges) {
        if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
          range.lines.push(line)
        }
      }
    } else if (lineNumber >= singleStartLine && lineNumber <= singleEndLine) {
      selectedLines.push(line)
    }
  }

  const shouldStopAfterLine = () => Number.isFinite(maxRequestedEndLine) && lineNumber >= maxRequestedEndLine

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      encoding: 'utf8',
    })

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    stream.on('data', chunk => {
      if (wholeFileHasher && !stoppedEarly) {
        // The stream is opened with encoding 'utf8' so chunks are strings at runtime,
        // but the Node types still model `string | Buffer`. Hash.update accepts both,
        // and defaults to utf8 for strings, so dropping the explicit encoding is
        // behaviour-identical and type-safe for either.
        wholeFileHasher.update(chunk)
      }

      const working = carry + chunk
      carry = ''

      let startIdx = 0
      for (let i = 0; i < working.length; i++) {
        if (working[i] !== '\n') continue

        let line = working.slice(startIdx, i)
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
          sawCRLF = true
        } else {
          sawLFOnly = true
        }

        processLine(line)
        endedWithLineBreak = true

        if (shouldStopAfterLine()) {
          stoppedEarly = true
          stream.destroy()
          return
        }

        startIdx = i + 1
      }

      carry = working.slice(startIdx)
      if (carry.length > 0) {
        endedWithLineBreak = false
      }
    })

    stream.on('end', () => {
      if (!stoppedEarly) {
        if (carry.length > 0) {
          processLine(carry)
          endedWithLineBreak = false
        } else if (endedWithLineBreak) {
          processLine('')
        } else if (lineNumber === 0) {
          // Match String.split behavior for empty files: ['']
          processLine('')
        }
        reachedEOF = true
      }

      finish()
    })

    stream.on('close', () => {
      if (stoppedEarly) {
        finish()
      }
    })

    stream.on('error', fail)
  })

  const lineEndingStyle: '\n' | '\r\n' | 'mixed' = sawCRLF && sawLFOnly ? 'mixed' : sawCRLF ? '\r\n' : '\n'
  const joinLineEnding = lineEndingStyle === 'mixed' || lineEndingStyle === '\r\n' ? '\r\n' : '\n'

  const totalLines = reachedEOF ? lineNumber : undefined
  const fileHash = includeHash && reachedEOF && wholeFileHasher ? wholeFileHasher.digest('hex') : undefined

  if (hasRanges) {
    const selectedParts: string[] = []
    const rangesInfo: Array<{ startLine: number; endLine: number; lineCount: number }> = []

    for (const range of requestedRanges) {
      if (totalLines !== undefined && range.startLine > totalLines) {
        throw new Error(`Range startLine ${range.startLine} exceeds total lines ${totalLines} in file`)
      }

      const effectiveEndLine = totalLines !== undefined ? Math.min(totalLines, range.endLine) : range.endLine
      if (effectiveEndLine < range.startLine) {
        throw new Error(`Range endLine ${effectiveEndLine} cannot be less than startLine ${range.startLine}`)
      }

      selectedParts.push(range.lines.join(joinLineEnding))
      if (requestedRanges.length > 1) {
        selectedParts.push('')
      }

      rangesInfo.push({
        startLine: range.startLine,
        endLine: effectiveEndLine,
        lineCount: range.lines.length,
      })
    }

    if (selectedParts[selectedParts.length - 1] === '') {
      selectedParts.pop()
    }

    return {
      content: selectedParts.join(joinLineEnding),
      totalLines,
      ranges: rangesInfo,
      lineEndingStyle,
      fileHash,
    }
  }

  if (totalLines !== undefined && singleStartLine > totalLines) {
    throw new Error(`startLine ${singleStartLine} exceeds total lines ${totalLines} in file`)
  }

  const effectiveEndLine =
    Number.isFinite(singleEndLine) && totalLines !== undefined
      ? Math.min(totalLines, singleEndLine)
      : Number.isFinite(singleEndLine)
        ? singleEndLine
        : totalLines !== undefined
          ? totalLines
          : lineNumber

  if (effectiveEndLine < singleStartLine) {
    throw new Error(`endLine ${effectiveEndLine} cannot be less than startLine ${singleStartLine}`)
  }

  return {
    content: selectedLines.join(joinLineEnding),
    startLine: singleStartLine,
    endLine: effectiveEndLine,
    totalLines,
    lineEndingStyle,
    fileHash,
  }
}

export async function readTextFile(inputPath: string, options: ReadFileOptions = {}): Promise<ReadFileResult> {
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 200 * 1024
  const includeHash = options.includeHash === true // default to false

  validateLineRangeValues(options)

  // Resolve absolute path and track path type
  let abs = inputPath
  let pathType: 'windows' | 'wsl' | 'posix' = 'posix'
  const willBeWsl = isWSLPath(inputPath)

  if (willBeWsl) {
    pathType = 'wsl'
    abs = resolveWslLikeAbsolutePath(inputPath, options.cwd)
  } else {
    const basePath = options.cwd || process.cwd()
    abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(basePath, inputPath)
    if (/^[a-zA-Z]:[\\\/]/.test(abs)) {
      pathType = 'windows'
    }
  }

  if (options.cwd) {
    assertWithinWorkspace(inputPath, abs, options.cwd, pathType === 'wsl')
  }

  // Convert to UNC for filesystem access
  if (pathType === 'wsl') {
    abs = await resolveToWindowsPath(abs)
  }

  // Check existence and get size
  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(abs)
  } catch (e) {
    throw new Error(`File '${inputPath}' does not exist or is not accessible`)
  }
  if (!stats.isFile()) {
    throw new Error(`'${inputPath}' is not a file`)
  }

  const sizeBytes = stats.size

  // Determine if we need line-based access
  const needsLineAccess =
    options.startLine !== undefined || options.endLine !== undefined || (options.ranges && options.ranges.length > 0)

  if (needsLineAccess) {
    const probeBuf = await readProbeBytes(abs, Math.min(sizeBytes, 4096))

    if (isLikelyBinary(probeBuf)) {
      throw new Error('Binary file detected; reading binary is not supported by this tool')
    }

    const bomDetected = hasBOM(probeBuf)
    const lineSelection = await readLineSelectionFromFile(abs, options, includeHash)
    const contentHash = includeHash ? calculateHash(lineSelection.content) : undefined

    const metadata: FileMetadata = {
      lineEnding: lineSelection.lineEndingStyle,
      hasBOM: bomDetected,
      encoding: 'utf8',
      lastModified: stats.mtime,
      inode: stats.ino,
    }

    return {
      content: lineSelection.content,
      truncated: false,
      sizeBytes,
      contentHash,
      fileHash: lineSelection.fileHash,
      metadata,
      startLine: lineSelection.startLine,
      endLine: lineSelection.endLine,
      totalLines: lineSelection.totalLines,
      ranges: lineSelection.ranges,
    }
  }

  // Only apply maxBytes truncation if NOT doing line-based slicing
  const toRead = Math.min(sizeBytes, maxBytes)

  // Read only up to maxBytes
  let buf: Buffer
  if (toRead === sizeBytes) {
    buf = await fs.promises.readFile(abs)
  } else {
    const fd = await fs.promises.open(abs, 'r')
    try {
      buf = Buffer.allocUnsafe(toRead)
      await fd.read(buf, 0, toRead, 0)
    } finally {
      await fd.close()
    }
  }

  // Detect binary
  if (isLikelyBinary(buf)) {
    throw new Error('Binary file detected; reading binary is not supported by this tool')
  }

  // Collect metadata before processing
  const bomDetected = hasBOM(buf)
  const content = buf.toString('utf8')
  const truncated = sizeBytes > maxBytes

  // Detect line ending style from returned content
  const lineEndingStyle = detectLineEnding(content)

  // Calculate content hashes if requested
  const contentHash = includeHash ? calculateHash(content) : undefined
  const fileHash = contentHash

  // Build metadata
  const metadata: FileMetadata = {
    lineEnding: lineEndingStyle,
    hasBOM: bomDetected,
    encoding: 'utf8',
    lastModified: stats.mtime,
    inode: stats.ino,
  }

  return {
    content,
    truncated,
    sizeBytes,
    contentHash,
    fileHash,
    metadata,
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
  if (afterLine < 0) {
    throw new Error('afterLine must be >= 0 (use 0 to read from beginning)')
  }
  if (numLines < 1) {
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
