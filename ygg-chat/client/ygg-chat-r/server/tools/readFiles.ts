import * as path from 'path'
import { isWSLPath, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'
import { ReadFileOptions, readTextFile } from './readFile.js'

export interface ReadMultipleOptions extends ReadFileOptions {
  baseDir?: string // used to compute the header-relative path separator
  // Inherits startLine, endLine, ranges, maxBytes from ReadFileOptions
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

export function formatReadFilesContent(files: ReadMultipleFileResult[]): string {
  return files
    .map(file => {
      const body = file.success ? file.content : `[Error reading file: ${file.error || 'Unknown error'}]`
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

  const results: ReadMultipleFileResult[] = new Array(inputPaths.length)

  const readOne = async (p: string, index: number): Promise<void> => {
    try {
      const res = await readTextFile(p, {
        maxBytes: options.maxBytes,
        startLine: options.startLine,
        endLine: options.endLine,
        ranges: options.ranges,
        cwd: options.cwd,
        includeHash: false,
      })

      let absResolved = p
      if (isWSLPath(p)) {
        absResolved = await resolveToWindowsPath(p)
      } else {
        absResolved = path.isAbsolute(p) ? p : path.resolve(cwdBase, p)
      }

      const rel = buildRelativeFilename(baseDir, absResolved)

      let totalLines = res.totalLines
      if (totalLines === undefined) {
        // Calculate returned-content line count when full total is unavailable (e.g. bounded line reads)
        totalLines = res.content.split(/\r?\n/).length
      }

      results[index] = {
        filename: rel,
        content: res.content,
        totalLines,
        success: true,
        truncated: res.truncated,
        sizeBytes: res.sizeBytes,
        startLine: res.startLine,
        endLine: res.endLine,
        ranges: res.ranges,
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      results[index] = {
        filename: p,
        content: `[Error reading file: ${errorMsg}]`,
        totalLines: 0,
        success: false,
        error: errorMsg,
      }
    }
  }

  const concurrency = Math.min(4, inputPaths.length)
  let nextIndex = 0

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= inputPaths.length) {
        return
      }

      await readOne(inputPaths[currentIndex], currentIndex)
    }
  })

  await Promise.all(workers)

  return results
}
