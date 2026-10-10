import { hasFullToolAccess } from '../toolAccessContext.js'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWSLPath, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'

// Internal complete-file reads are independent of the public read_file output budget.
const MAX_EDIT_BYTES = 32 * 1024 * 1024
const pendingEdits = new Map<string, Promise<void>>()

function assertScope(target: string, workspace: string, posix = false): void {
  if (hasFullToolAccess()) return
  const paths = posix ? path.posix : path
  const relative = paths.relative(workspace, target)
  if (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) return
  if (!isManagedToolPath(workspace, posix) && isManagedToolPath(target, posix)) return
  throw new Error(`Access denied: Path '${target}' is outside the workspace '${workspace}'.`)
}

export async function resolveEditPath(input: string, cwd?: string, allowCreate = false): Promise<string> {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('path must be a non-empty file path without null bytes')
  const base = cwd || process.cwd()
  const wsl = isWSLPath(input) || (!path.isAbsolute(input) && isWSLPath(base))
  let target = wsl ? path.posix.resolve(toWslPath(base), toWslPath(input)) : path.resolve(base, input)
  if (cwd) assertScope(target, wsl ? path.posix.resolve(toWslPath(cwd)) : path.resolve(cwd), wsl)
  if (wsl) target = await resolveToWindowsPath(target)
  try {
    target = await fs.promises.realpath(target)
  } catch (error) {
    if (!allowCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling symlink must never be mistaken for an absent target.
    const entry = await fs.promises.lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (entry) throw new Error('Refusing to create a file through a dangling symlink')
    target = path.join(await fs.promises.realpath(path.dirname(target)), path.basename(target))
  }
  if (cwd) {
    const nativeScope = isWSLPath(cwd) ? await resolveToWindowsPath(cwd) : cwd
    assertScope(target, await fs.promises.realpath(nativeScope))
  }
  return target
}

export function sameFileVersion(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

export interface EditTarget {
  path: string
  stats: fs.Stats | null
  content: string
  sizeBytes: number
  previouslyEdited: boolean
  write: (content: string, append?: boolean) => Promise<void>
  backup: () => Promise<string>
}

export async function withEditTarget<T>(
  input: string,
  options: { cwd?: string; encoding?: BufferEncoding; allowCreate?: boolean; operationMode?: 'plan' | 'execute'; versions?: Map<string, fs.Stats>; targets?: Map<string, string>; beforeWrite?: (absolutePath: string, originalPath: string) => Promise<void> },
  run: (target: EditTarget) => Promise<T>
): Promise<T> {
  if (options.operationMode === 'plan') throw new Error('File modification is not allowed in planning mode')
  const encoding = options.encoding ?? 'utf8'
  if (!['utf8', 'utf-8', 'utf16le', 'utf-16le', 'ucs2', 'ucs-2', 'latin1', 'binary', 'ascii'].includes(encoding)) {
    throw new Error(`Unsupported text encoding: ${encoding}`)
  }
  const targetPath = await resolveEditPath(input, options.cwd, options.allowCreate)
  const key = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
  const base = options.cwd || process.cwd()
  const inputKey = isWSLPath(input) || isWSLPath(base)
    ? path.posix.resolve(toWslPath(base), toWslPath(input)) : path.resolve(base, input)
  const previousTarget = options.targets?.get(inputKey)
  if (previousTarget !== undefined && previousTarget !== key) throw new Error('File path changed between batch edits')
  options.targets?.set(inputKey, key)
  const previous = pendingEdits.get(key)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  pendingEdits.set(key, pending)
  await previous
  let fd: fs.promises.FileHandle | undefined
  try {
    // Open without truncation; a final-component symlink swap is rejected on POSIX.
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW
    try {
      fd = await fs.promises.open(targetPath, fs.constants.O_RDWR | noFollow)
    } catch (error) {
      if (!options.allowCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const stats = fd ? await fd.stat() : null
    if (stats && !stats.isFile()) throw new Error(`'${input}' is not a file`)
    const expected = options.versions?.get(key)
    if (expected && (!stats || !sameFileVersion(stats, expected))) throw new Error('File has been modified between batch edits')
    if (stats && stats.size > MAX_EDIT_BYTES) throw new Error('File exceeds the 32 MiB edit safety limit')
    // Read once, with a one-byte lookahead for growth. No public-read truncation.
    const bytes = Buffer.allocUnsafe((stats?.size ?? 0) + 1)
    let length = 0
    if (fd) {
      while (length < bytes.length) {
        const { bytesRead } = await fd.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
    }
    if (stats && length !== stats.size) throw new Error('File changed while being read')
    // A changed version is checked before every write; no-op edits need no extra stat.
    const original = bytes.subarray(0, length)
    const utf16 = ['utf16le', 'utf-16le', 'ucs2', 'ucs-2'].includes(encoding)
    if (!utf16 && original.subarray(0, 4096).includes(0)) throw new Error('Binary file detected; editing binary is not supported')
    const content = original.toString(encoding)
    // UTF-8 without replacement characters is lossless; avoid a second whole-file
    // buffer allocation on the common path. Latin-1 also maps every byte exactly.
    const lossless = (encoding === 'utf8' || encoding === 'utf-8') ? !content.includes('\ufffd')
      : (encoding === 'latin1' || encoding === 'binary')
    if (!lossless && !Buffer.from(content, encoding).equals(original)) throw new Error(`File cannot be decoded losslessly as ${encoding}`)
    const target: EditTarget = {
      path: targetPath, stats, content, sizeBytes: length, previouslyEdited: Boolean(expected),
      backup: async () => {
        const backupPath = `${targetPath}.backup.${Date.now()}.${randomUUID()}`
        await fs.promises.writeFile(backupPath, original, { flag: 'wx', mode: stats?.mode })
        return backupPath
      },
      write: async (text, append = false) => {
        const output = Buffer.from(text, encoding)
        if (output.length + (append ? length : 0) > MAX_EDIT_BYTES) throw new Error('Result exceeds the 32 MiB edit safety limit')
        await options.beforeWrite?.(targetPath, input)
        // Recheck canonical parents before opening/committing. This is conflict detection,
        // not a sandbox against an adversarial process racing ancestor-directory renames.
        if (fd && stats) {
          const [resolved, current, opened] = await Promise.all([
            resolveEditPath(input, options.cwd, options.allowCreate),
            fs.promises.stat(targetPath),
            fd.stat(),
          ])
          if (resolved !== targetPath) throw new Error('File path changed before writing')
          if (!sameFileVersion(stats, current) || !sameFileVersion(stats, opened)) throw new Error('File changed before writing')
        } else {
          if (await resolveEditPath(input, options.cwd, options.allowCreate) !== targetPath) throw new Error('File path changed before writing')
          fd = await fs.promises.open(targetPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow)
        }
        let offset = 0
        while (offset < output.length) {
          const { bytesWritten } = await fd.write(output, offset, output.length - offset, (append ? length : 0) + offset)
          if (!bytesWritten) throw new Error('File write made no progress')
          offset += bytesWritten
        }
        if (!append && output.length < length) await fd.truncate(output.length)
        if (options.versions) target.stats = await fd.stat()
      },
    }
    const result = await run(target)
    if (target.stats && (result as { success?: boolean }).success) options.versions?.set(key, target.stats)
    return result
  } finally {
    try { await fd?.close() } finally {
      release()
      if (pendingEdits.get(key) === pending) pendingEdits.delete(key)
    }
  }
}
