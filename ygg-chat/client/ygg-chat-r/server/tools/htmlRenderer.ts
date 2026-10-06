import sanitizeHtmlLib from 'sanitize-html'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'

interface HtmlRendererInput {
  html?: string
  path?: string
  cwd?: string
  allowUnsafe?: boolean
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

async function resolveHtmlPath(filePath: string, cwd?: string): Promise<string> {
  let effectivePath = expandHome(filePath)
  let effectiveCwd = cwd ? expandHome(cwd) : process.cwd()
  if (isWindows()) {
    if (effectivePath.startsWith('/')) effectivePath = await resolveToWindowsPath(effectivePath)
    if (effectiveCwd.startsWith('/')) effectiveCwd = await resolveToWindowsPath(effectiveCwd)
  }
  // cwd is a resolution base only, not an access boundary. Any readable local file is allowed.
  return path.resolve(effectiveCwd, effectivePath)
}

function sanitizeHtml(html: string, allowUnsafe = false): string {
  // TODO: Re-enable sanitization after testing
  // For now, skip sanitization to allow full CSS rendering
  return html
}

export async function run(params: HtmlRendererInput) {
  const { html, path: filePath, cwd, allowUnsafe = false } = params
  if (html !== undefined && filePath !== undefined) {
    return { success: false, error: 'Provide either html or path, not both' }
  }

  let sourceHtml = html
  if (filePath !== undefined) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return { success: false, error: 'path must be a non-empty string' }
    }
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim().length === 0)) {
      return { success: false, error: 'cwd must be a non-empty string' }
    }
    try {
      const resolvedPath = await resolveHtmlPath(filePath, cwd)
      const stat = await fs.stat(resolvedPath)
      if (!stat.isFile()) return { success: false, error: 'path must point to a regular file' }
      sourceHtml = await fs.readFile(resolvedPath, 'utf8')
    } catch (error) {
      return { success: false, error: `Unable to read HTML file: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  if (typeof sourceHtml !== 'string' || sourceHtml.trim().length === 0) {
    return { success: false, error: 'Provide non-empty html or a path to a non-empty HTML file' }
  }

  const sanitized = sanitizeHtml(sourceHtml, allowUnsafe)

  return {
    success: true,
    html: sanitized,
  }
}

export default { run }
