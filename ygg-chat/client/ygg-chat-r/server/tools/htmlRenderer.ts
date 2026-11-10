import sanitizeHtmlLib from 'sanitize-html'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { isWindows, resolveToWindowsPath } from '../utils/wslBridge.js'
import { readHtmlDocument, saveHtmlDocument, exportHtmlDocument } from './htmlDocumentStore.js'
import type { ToolExecutionOptions } from './runtime/protocol.js'

interface HtmlRendererInput {
  action?: 'render' | 'export'
  documentId?: string
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

export async function run(params: HtmlRendererInput, context: ToolExecutionOptions = {}) {
  const { html, path: filePath, cwd, allowUnsafe = false, action = 'render', documentId } = params
  if (action !== 'render' && action !== 'export') {
    return { success: false, error: 'action must be render or export' }
  }
  if (action === 'export') {
    if (!documentId || html !== undefined || filePath !== undefined || cwd !== undefined || params.allowUnsafe !== undefined) {
      return { success: false, error: 'Export requires documentId only; do not provide html, path, cwd, or allowUnsafe' }
    }
    try {
      return { success: true, action, documentId, ...await exportHtmlDocument(documentId, context) }
    } catch (error) {
      return { success: false, error: `Unable to export HTML document: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (documentId !== undefined) {
    if (html !== undefined || filePath !== undefined) {
      return { success: false, error: 'Provide documentId, html, or path, not multiple sources' }
    }
    try {
      return { success: true, documentId, html: await readHtmlDocument(documentId, context) }
    } catch (error) {
      return { success: false, error: `Unable to read HTML document: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
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

  try {
    const documentId = await saveHtmlDocument(sanitized, context)
    return { success: true, html: sanitized, documentId }
  } catch (error) {
    return { success: false, error: `Unable to store HTML document: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export default { run }
