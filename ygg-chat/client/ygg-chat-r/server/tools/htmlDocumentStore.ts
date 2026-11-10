import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { tryGetServerConfig } from '../serverHost.js'
import type { ToolExecutionOptions } from './runtime/protocol.js'

const DOCUMENT_ID = /^html_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type DocumentRecord = { version: 1; documentId: string; html: string }

function getDocumentDirectory(context: ToolExecutionOptions): string {
  // Match managed themes; the utility process inherits the host's user-data env.
  const dataDir = process.env.YGG_APP_USER_DATA?.trim() || tryGetServerConfig()?.dataDir || process.env.YGG_DATA_DIR?.trim()
  if (!dataDir) throw new Error('HTML document storage requires a configured host data directory')
  // Scope comes from trusted execution options, never model-provided arguments.
  const scope = context.conversationId
    ? `conversation:${context.conversationId}`
    : context.rootPath ? `workspace:${path.resolve(context.rootPath)}` : 'host'
  const scopeId = createHash('sha256').update(scope).digest('hex')
  return path.join(dataDir, '.ygg', 'html-documents', scopeId)
}

function validateDocumentId(documentId: string): void {
  if (typeof documentId !== 'string' || !DOCUMENT_ID.test(documentId)) {
    throw new Error('documentId must be an HTML document ID returned by html_renderer')
  }
}

export async function saveHtmlDocument(html: string, context: ToolExecutionOptions): Promise<string> {
  const directory = getDocumentDirectory(context)
  await fs.mkdir(directory, { recursive: true })
  const documentId = `html_${randomUUID()}`
  const record: DocumentRecord = { version: 1, documentId, html }
  await fs.writeFile(path.join(directory, `${documentId}.json`), JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return documentId
}

export async function readHtmlDocument(documentId: string, context: ToolExecutionOptions): Promise<string> {
  validateDocumentId(documentId)
  const filePath = path.join(getDocumentDirectory(context), `${documentId}.json`)
  let record: DocumentRecord
  try {
    record = JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('HTML document not found in this conversation or workspace')
    }
    throw error
  }
  if (record?.version !== 1 || record.documentId !== documentId || typeof record.html !== 'string' || !record.html.trim()) {
    throw new Error('Invalid stored HTML document')
  }
  return record.html
}

export async function exportHtmlDocument(documentId: string, context: ToolExecutionOptions): Promise<{ path: string; sizeBytes: number }> {
  const html = await readHtmlDocument(documentId, context)
  const directory = path.join(getDocumentDirectory(context), 'exports')
  await fs.mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `${documentId}.html`)
  const stagingPath = path.join(directory, `.${documentId}-${randomUUID()}.tmp`)
  await fs.writeFile(stagingPath, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    try {
      // Publish only a complete file, exclusively, even across processes.
      await fs.link(stagingPath, filePath)
    } catch (error) {
      // Repeated export is safe, but never overwrite an edited file or symlink.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || await fs.readFile(filePath, 'utf8') !== html) {
        throw new Error('Export already exists with different content; refusing to overwrite')
      }
    }
  } finally {
    await fs.unlink(stagingPath)
  }
  return { path: filePath, sizeBytes: Buffer.byteLength(html, 'utf8') }
}
