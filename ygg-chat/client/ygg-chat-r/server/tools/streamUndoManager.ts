import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export type StreamUndoStatus = 'available' | 'restoring' | 'restored' | 'invalidated' | 'failed'

export interface StreamUndoOperationEntry {
  toolCallId: string | null
  toolName: 'edit_file' | 'multi_edit'
  operation?: string | null
  index?: number | null
  timestamp: string
}

export interface StreamUndoFileEntry {
  originalPath: string
  absolutePath: string
  backupRelativePath: string
  existedBefore: boolean
  sizeBytes: number
  sha256Before: string | null
  sha256AfterFirstEdit?: string | null
  lastKnownSha256?: string | null
  firstToolCallId: string | null
  toolCallIds: string[]
  operations: StreamUndoOperationEntry[]
}

export interface StreamUndoManifest {
  version: 1
  conversationId: string | null
  streamId: string
  parentMessageId: string | null
  assistantMessageId?: string | null
  rootPath: string | null
  cwd: string | null
  createdAt: string
  updatedAt: string
  status: StreamUndoStatus
  restoredAt?: string | null
  restoredByMessageId?: string | null
  files: StreamUndoFileEntry[]
  restoreLog?: Array<{ timestamp: string; path: string; action: 'restored' | 'skipped' | 'failed'; message?: string }>
}

export interface StreamUndoSummary {
  streamId: string
  conversationId: string | null
  parentMessageId: string | null
  assistantMessageId?: string | null
  status: StreamUndoStatus
  createdAt: string
  updatedAt: string
  restoredAt?: string | null
  fileCount: number
  files: Array<{ path: string; absolutePath: string; sizeBytes: number; operationCount: number }>
}

export interface StreamUndoRecordContext {
  streamId?: string | null
  conversationId?: string | null
  parentMessageId?: string | null
  messageId?: string | null
  rootPath?: string | null
  cwd?: string | null
  toolCallId?: string | null
}

export interface StreamUndoRestoreResult {
  success: boolean
  streamId: string
  restored: number
  skipped: number
  failed: number
  conflicts: Array<{ path: string; reason: string; expectedHash?: string | null; actualHash?: string | null }>
  manifest?: StreamUndoSummary
  error?: string
}

const BACKUP_ROOT_ENV = 'YGG_APP_USER_DATA'

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function getStreamUndoBaseDir(): string {
  const userData = process.env[BACKUP_ROOT_ENV]?.trim()
  const base = userData || path.resolve(process.cwd(), '.ygg-chat-r')
  return path.join(base, '.ygg', 'backups')
}

function safeStreamId(streamId: string): string {
  const safe = streamId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
  const hash = crypto.createHash('sha256').update(streamId).digest('hex').slice(0, 12)
  return `${safe || 'stream'}-${hash}`
}

function streamDir(streamId: string): string {
  return path.join(getStreamUndoBaseDir(), safeStreamId(streamId))
}

function manifestPath(streamId: string): string {
  return path.join(streamDir(streamId), 'manifest.json')
}

function backupRelativePathForAbsolutePath(absolutePath: string): string {
  const hash = crypto.createHash('sha256').update(absolutePath).digest('hex')
  return path.join('files', `${hash}.bak`)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true })
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function fileHash(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.promises.readFile(filePath))
  } catch {
    return null
  }
}

async function readManifest(streamId: string): Promise<StreamUndoManifest | null> {
  try {
    const raw = await fs.promises.readFile(manifestPath(streamId), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && parsed.version === 1 ? (parsed as StreamUndoManifest) : null
  } catch {
    return null
  }
}

async function writeManifest(manifest: StreamUndoManifest): Promise<void> {
  const dir = streamDir(manifest.streamId)
  await ensureDir(dir)
  const file = manifestPath(manifest.streamId)
  const tmp = `${file}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
  await fs.promises.rename(tmp, file)
}

function reconcileManifestContext(manifest: StreamUndoManifest, context: StreamUndoRecordContext): boolean {
  let changed = false
  const candidateParentMessageId = isNonEmptyString(context.parentMessageId) ? context.parentMessageId : null
  const currentParentMessageId = isNonEmptyString(manifest.parentMessageId) ? manifest.parentMessageId : null
  const messageId = isNonEmptyString(context.messageId) ? context.messageId : null

  if (candidateParentMessageId && (!currentParentMessageId || (messageId && currentParentMessageId === messageId))) {
    manifest.parentMessageId = candidateParentMessageId
    changed = true
  }
  if (!manifest.conversationId && isNonEmptyString(context.conversationId)) {
    manifest.conversationId = context.conversationId
    changed = true
  }
  if (!manifest.rootPath && isNonEmptyString(context.rootPath)) {
    manifest.rootPath = context.rootPath
    changed = true
  }
  if (!manifest.cwd && (isNonEmptyString(context.cwd) || isNonEmptyString(context.rootPath))) {
    manifest.cwd = context.cwd ?? context.rootPath ?? null
    changed = true
  }
  if (changed) {
    manifest.updatedAt = new Date().toISOString()
  }
  return changed
}

async function getOrCreateManifest(context: StreamUndoRecordContext & { streamId: string }): Promise<StreamUndoManifest> {
  const existing = await readManifest(context.streamId)
  if (existing) return existing
  const now = new Date().toISOString()
  return {
    version: 1,
    conversationId: context.conversationId ?? null,
    streamId: context.streamId,
    parentMessageId: context.parentMessageId ?? context.messageId ?? null,
    rootPath: context.rootPath ?? null,
    cwd: context.cwd ?? context.rootPath ?? null,
    createdAt: now,
    updatedAt: now,
    status: 'available',
    files: [],
  }
}

export async function recordPreEditBackup(params: StreamUndoRecordContext & { originalPath: string; absolutePath: string }): Promise<void> {
  if (!isNonEmptyString(params.streamId)) return
  const absolutePath = path.resolve(params.absolutePath)
  const manifest = await getOrCreateManifest({ ...params, streamId: params.streamId })
  const contextChanged = reconcileManifestContext(manifest, params)
  if (manifest.status !== 'available') {
    if (contextChanged) await writeManifest(manifest)
    return
  }
  if (manifest.files.some(file => path.resolve(file.absolutePath) === absolutePath)) {
    if (contextChanged) await writeManifest(manifest)
    return
  }

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(absolutePath)
  } catch {
    return
  }
  if (!stat.isFile()) return

  const content = await fs.promises.readFile(absolutePath)
  const backupRel = backupRelativePathForAbsolutePath(absolutePath)
  const backupPath = path.join(streamDir(params.streamId), backupRel)
  await ensureDir(path.dirname(backupPath))
  await fs.promises.writeFile(backupPath, content)

  manifest.files.push({
    originalPath: params.originalPath,
    absolutePath,
    backupRelativePath: backupRel,
    existedBefore: true,
    sizeBytes: stat.size,
    sha256Before: sha256(content),
    firstToolCallId: params.toolCallId ?? null,
    toolCallIds: params.toolCallId ? [params.toolCallId] : [],
    operations: [],
  })
  manifest.updatedAt = new Date().toISOString()
  await writeManifest(manifest)
}

export async function recordToolEditSuccess(
  params: StreamUndoRecordContext & {
    originalPath: string
    absolutePath: string
    toolName: 'edit_file' | 'multi_edit'
    operation?: string | null
    index?: number | null
  }
): Promise<void> {
  if (!isNonEmptyString(params.streamId)) return
  const absolutePath = path.resolve(params.absolutePath)
  const manifest = await readManifest(params.streamId)
  if (!manifest) return
  const contextChanged = reconcileManifestContext(manifest, params)
  if (manifest.status !== 'available') {
    if (contextChanged) await writeManifest(manifest)
    return
  }
  const file = manifest.files.find(entry => path.resolve(entry.absolutePath) === absolutePath)
  if (!file) {
    if (contextChanged) await writeManifest(manifest)
    return
  }

  const now = new Date().toISOString()
  const toolCallId = params.toolCallId ?? null
  if (toolCallId && !file.toolCallIds.includes(toolCallId)) {
    file.toolCallIds.push(toolCallId)
  }
  file.operations.push({
    toolCallId,
    toolName: params.toolName,
    operation: params.operation ?? null,
    index: params.index ?? null,
    timestamp: now,
  })
  const currentHash = await fileHash(absolutePath)
  file.sha256AfterFirstEdit = file.sha256AfterFirstEdit ?? currentHash ?? undefined
  file.lastKnownSha256 = currentHash ?? undefined
  manifest.updatedAt = now
  await writeManifest(manifest)
}

export async function markStreamUndoAssistantMessage(streamId: string, assistantMessageId: string | null): Promise<StreamUndoSummary | null> {
  if (!isNonEmptyString(streamId)) return null
  const manifest = await readManifest(streamId)
  if (!manifest) return null
  manifest.assistantMessageId = assistantMessageId ?? null
  manifest.updatedAt = new Date().toISOString()
  await writeManifest(manifest)
  return toSummary(manifest)
}

export async function getStreamUndoSummary(streamId: string): Promise<StreamUndoSummary | null> {
  const manifest = await readManifest(streamId)
  return manifest ? toSummary(manifest) : null
}

export async function listStreamUndoSummariesByConversation(conversationId: string): Promise<StreamUndoSummary[]> {
  const base = getStreamUndoBaseDir()
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const summaries: StreamUndoSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await fs.promises.readFile(path.join(base, entry.name, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw) as StreamUndoManifest
      if (String(manifest.conversationId) === String(conversationId)) {
        summaries.push(toSummary(manifest))
      }
    } catch {
      // Ignore malformed manifests.
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function restoreStreamUndo(
  streamId: string,
  options: { force?: boolean; expectedParentMessageId?: string | null; restoredByMessageId?: string | null } = {}
): Promise<StreamUndoRestoreResult> {
  const manifest = await readManifest(streamId)
  if (!manifest) {
    return { success: false, streamId, restored: 0, skipped: 0, failed: 0, conflicts: [], error: 'Undo manifest not found' }
  }
  if (options.expectedParentMessageId && String(manifest.parentMessageId) !== String(options.expectedParentMessageId)) {
    return { success: false, streamId, restored: 0, skipped: 0, failed: 0, conflicts: [], error: 'Parent message mismatch' }
  }
  if (manifest.status !== 'available') {
    return { success: false, streamId, restored: 0, skipped: 0, failed: 0, conflicts: [], error: `Undo is ${manifest.status}` }
  }

  const conflicts: StreamUndoRestoreResult['conflicts'] = []
  if (!options.force) {
    for (const file of manifest.files) {
      const actualHash = await fileHash(file.absolutePath)
      const expectedHash = file.lastKnownSha256 ?? file.sha256AfterFirstEdit ?? null
      if (expectedHash && actualHash && actualHash !== expectedHash) {
        conflicts.push({ path: file.originalPath || file.absolutePath, reason: 'File changed after stream edit', expectedHash, actualHash })
      }
    }
  }
  if (conflicts.length > 0) {
    return { success: false, streamId, restored: 0, skipped: 0, failed: 0, conflicts, manifest: toSummary(manifest) }
  }

  manifest.status = 'restoring'
  manifest.updatedAt = new Date().toISOString()
  await writeManifest(manifest)

  let restored = 0
  let skipped = 0
  let failed = 0
  const restoreLog: NonNullable<StreamUndoManifest['restoreLog']> = manifest.restoreLog ?? []
  for (const file of manifest.files) {
    const timestamp = new Date().toISOString()
    try {
      const backupPath = path.join(streamDir(streamId), file.backupRelativePath)
      if (!file.existedBefore) {
        skipped += 1
        restoreLog.push({ timestamp, path: file.absolutePath, action: 'skipped', message: 'File did not exist before edit' })
        continue
      }
      await ensureDir(path.dirname(file.absolutePath))
      await fs.promises.copyFile(backupPath, file.absolutePath)
      restored += 1
      restoreLog.push({ timestamp, path: file.absolutePath, action: 'restored' })
    } catch (error) {
      failed += 1
      restoreLog.push({ timestamp, path: file.absolutePath, action: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  manifest.status = failed > 0 ? 'failed' : 'restored'
  manifest.restoredAt = new Date().toISOString()
  manifest.restoredByMessageId = options.restoredByMessageId ?? null
  manifest.restoreLog = restoreLog
  manifest.updatedAt = manifest.restoredAt
  await writeManifest(manifest)

  return { success: failed === 0, streamId, restored, skipped, failed, conflicts: [], manifest: toSummary(manifest) }
}

function toSummary(manifest: StreamUndoManifest): StreamUndoSummary {
  return {
    streamId: manifest.streamId,
    conversationId: manifest.conversationId,
    parentMessageId: manifest.parentMessageId,
    assistantMessageId: manifest.assistantMessageId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    restoredAt: manifest.restoredAt,
    fileCount: manifest.files.length,
    files: manifest.files.map(file => ({
      path: file.originalPath || file.absolutePath,
      absolutePath: file.absolutePath,
      sizeBytes: file.sizeBytes,
      operationCount: file.operations.length,
    })),
  }
}
