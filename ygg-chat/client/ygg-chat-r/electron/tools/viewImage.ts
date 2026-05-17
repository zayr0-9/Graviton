import * as fs from 'fs'
import * as path from 'path'
import { isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWindows, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface ViewImageOptions {
  cwd?: string
  detail?: 'high' | 'original'
  maxBytes?: number
}

export interface ViewImageResult {
  success: true
  path: string
  mimeType: string
  detail: 'high' | 'original'
  sizeBytes: number
  image_url: string
  content: Array<{
    type: 'input_image'
    image_url: string
    detail: 'high' | 'original'
  }>
}

function normalizeForCompare(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
}

function assertWithinWorkspace(inputPath: string, resolvedPath: string, cwd?: string): void {
  if (!cwd) return

  const normalizedRoot = normalizeForCompare(cwd)
  const normalizedTarget = normalizeForCompare(resolvedPath)
  const relative = path.relative(normalizedRoot, normalizedTarget)
  const outsideWorkspace = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)

  if (!outsideWorkspace) return

  const rootIsManagedPath = isManagedToolPath(normalizedRoot, false)
  const targetIsManagedPath = isManagedToolPath(normalizedTarget, false)
  if (!rootIsManagedPath && targetIsManagedPath) return

  throw new Error(
    `Access denied: Path '${inputPath}' resolves to '${resolvedPath}' which is outside the workspace '${cwd}'. Image viewing is restricted to the workspace directory.`
  )
}

async function resolveImagePath(inputPath: string, cwd?: string): Promise<string> {
  const trimmed = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (!trimmed) throw new Error('path is required')

  let effectivePath = trimmed
  let effectiveCwd = cwd?.trim() || undefined

  if (isWindows()) {
    if (effectivePath.startsWith('/')) effectivePath = await resolveToWindowsPath(effectivePath)
    if (effectiveCwd && effectiveCwd.startsWith('/')) effectiveCwd = await resolveToWindowsPath(effectiveCwd)
  }

  const resolved = path.isAbsolute(effectivePath)
    ? path.resolve(effectivePath)
    : path.resolve(effectiveCwd || process.cwd(), effectivePath)

  assertWithinWorkspace(inputPath, resolved, effectiveCwd)
  return resolved
}

function inferImageMimeType(filePath: string, bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (bytes.length >= 6) {
    const sig = bytes.toString('ascii', 0, 6)
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp'

  const ext = path.extname(filePath).toLowerCase()
  return IMAGE_MIME_BY_EXT[ext] || ''
}

export async function viewImage(inputPath: string, options: ViewImageOptions = {}): Promise<ViewImageResult> {
  const resolvedPath = await resolveImagePath(inputPath, options.cwd)
  const stat = await fs.promises.stat(resolvedPath)
  if (!stat.isFile()) throw new Error(`image path '${inputPath}' is not a file`)

  const maxBytes = Math.min(Math.max(Number(options.maxBytes || MAX_IMAGE_BYTES), 1), MAX_IMAGE_BYTES)
  if (stat.size > maxBytes) {
    throw new Error(`image file is too large (${stat.size} bytes). Maximum allowed is ${maxBytes} bytes.`)
  }

  const bytes = await fs.promises.readFile(resolvedPath)
  const mimeType = inferImageMimeType(resolvedPath, bytes)
  if (!mimeType || !mimeType.startsWith('image/')) {
    throw new Error(`unsupported or unknown image format for '${inputPath}'`)
  }

  const detail = options.detail === 'original' ? 'original' : 'high'
  const imageUrl = `data:${mimeType};base64,${bytes.toString('base64')}`

  return {
    success: true,
    path: resolvedPath,
    mimeType,
    detail,
    sizeBytes: bytes.length,
    image_url: imageUrl,
    content: [{ type: 'input_image', image_url: imageUrl, detail }],
  }
}

export default viewImage
