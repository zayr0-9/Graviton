import { appHttpRequest } from './appHttpRequest.js'
import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { hostClientPolicy } from './hostClientPolicy.js'
import { withToolAccess } from '../toolAccessContext.js'
import { validateAndResolvePath } from '../toolPathPolicy.js'
import { toolOrchestrator } from '../tools/orchestrator/index.js'
import { operationFingerprint } from '../headlessServer/persistence/operationReceiptRepo.js'
import { execute as customToolManager } from '../tools/customToolManager.js'
import { saveEditorFile, editorContentHash } from '../editorFileStore.js'

type AppSession = { rootPath: string | null; fullAccess: boolean; mode: 'plan' | 'execute'; toolName: string | null; expires: number }
const MUTATING = new Set(['fs.writeFile', 'fs.mkdir', 'exec.run', 'customTool.invoke', 'tools.invoke', 'http.request'])
const APP_TOOL_NAMES = new Set(['read_file', 'read_files', 'read_file_continuation', 'glob', 'ripgrep', 'create_file', 'edit_file', 'multi_edit', 'delete_file', 'bash', 'powershell'])
const METHODS = new Set(['fs.readFile', 'fs.stat', ...MUTATING])

/** Explicit app operations, not an IPC namespace proxy. Session context is fixed
 * by the parent UI, never by subsequent iframe arguments. Network peers remain
 * trusted; these capabilities isolate embedded apps, not authenticated devices. */
export function registerHostAppBridgeRoutes(app: Express): void {
  const sessions = new Map<string, AppSession>()
  const receipts = new Map<string, { fingerprint: string; result: Promise<any> }>()
  const dropSession = (id: string) => {
    sessions.delete(id)
    for (const key of receipts.keys()) if (JSON.parse(key)[0] === id) receipts.delete(key)
  }
  const reap = () => { for (const [id, session] of sessions) if (session.expires < Date.now()) dropSession(id) }
  app.post('/api/host/apps/sessions', hostClientPolicy, (req, res) => {
    reap()
    const body = req.body ?? {}
    if (sessions.size >= 256 || (body.rootPath != null && (typeof body.rootPath !== 'string' || body.rootPath.length > 4096)) ||
      (body.toolName != null && (typeof body.toolName !== 'string' || body.toolName.length > 200))) {
      res.status(400).json({ error: 'Invalid app context or app capacity reached' }); return
    }
    if (!body.rootPath) { res.status(400).json({ error: 'Select a host workspace before using app host operations' }); return }
    const id = randomUUID()
    sessions.set(id, { rootPath: body.rootPath || null, fullAccess: body.fullAccess === true,
      mode: body.mode === 'plan' ? 'plan' : 'execute', toolName: body.toolName || null, expires: Date.now() + 30 * 60_000 })
    res.json({ id })
  })
  app.delete('/api/host/apps/sessions/:id', hostClientPolicy, (req, res) => { dropSession(String(req.params.id)); res.json({ success: true }) })
  app.post('/api/host/apps/sessions/:id/commands', hostClientPolicy, async (req, res) => {
    reap()
    const sessionId = String(req.params.id)
    const session = sessions.get(sessionId)
    if (!session) { res.status(410).json({ error: 'App context expired. Retry the explicit action.' }); return }
    const { requestId, method, params = {} } = req.body ?? {}
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128 || !METHODS.has(method) || !params || typeof params !== 'object' || Array.isArray(params)) {
      res.status(400).json({ error: 'Invalid app command' }); return
    }
    session.expires = Date.now() + 30 * 60_000
    const key = JSON.stringify([sessionId, requestId])
    const fingerprint = operationFingerprint({ method, params })
    if (MUTATING.has(method) && session.mode !== 'execute') { res.json({ success: false, error: 'Switch to Agent Mode before this app action' }); return }
    const recordReceipt = MUTATING.has(method)
    const existing = recordReceipt ? receipts.get(key) : undefined
    if (existing && existing.fingerprint !== fingerprint) { res.status(409).json({ error: 'App request identity already used' }); return }
    if (recordReceipt && !existing && (receipts.size >= 4096 || [...receipts.keys()].filter(key => JSON.parse(key)[0] === sessionId).length >= 256)) { res.status(409).json({ error: 'App command receipt capacity reached; restart host before new commands' }); return }
    const result = existing?.result ?? withToolAccess(session.fullAccess, async () => {
      if (MUTATING.has(method) && session.mode !== 'execute') throw new Error('Switch to Agent Mode before this app action')
      const resolvePath = async (input: unknown, create = false): Promise<string> => {
        if (typeof input !== 'string' || !input || input.length > 4096) throw new Error('Valid host path required')
        const resolved = validateAndResolvePath(input, session.rootPath ?? undefined)
        let real: string
        try { real = await fs.realpath(resolved) }
        catch (error) {
          if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          real = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved))
        }
        // Resolve the root itself too; lexical checks alone do not contain symlinks.
        if (session.rootPath) validateAndResolvePath(real, await fs.realpath(session.rootPath))
        return real
      }
      const execute = async (toolName: string, args: Record<string, unknown>) => {
        if (!APP_TOOL_NAMES.has(toolName)) throw new Error('This tool is not available to embedded apps')
        const job = toolOrchestrator.submit(toolName, args, { rootPath: session.rootPath, fullAccess: session.fullAccess, operationMode: session.mode, retries: 0, timeoutMs: 180000,
          metadata: { app: session.toolName, appSession: sessionId } })
        for (;;) {
          const current = toolOrchestrator.getJob(job.id)
          if (!current) throw new Error('App tool job unavailable')
          if (current.status === 'completed') return current.result
          if (current.status === 'failed' || current.status === 'cancelled') throw new Error(current.error || 'App tool failed')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      if (method === 'fs.stat') {
        const stat = await fs.stat(await resolvePath(params.filePath))
        return { success: true, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs }
      }
      if (method === 'fs.readFile') {
        const file = await resolvePath(params.filePath)
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('App file read exceeds 16 MiB capacity')
        const content = await fs.readFile(file, 'utf8')
        return { success: true, content, hash: editorContentHash(content) }
      }
      if (method === 'fs.writeFile') {
        if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > 16 * 1024 * 1024) throw new Error('Invalid app file content')
        const file = await resolvePath(params.filePath, true)
        try {
          const hash = await saveEditorFile(file, params.content, params.expectedHash)
          return { success: true, hash }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await fs.writeFile(file, params.content, { encoding: 'utf8', flag: 'wx' })
          return { success: true, hash: editorContentHash(params.content) }
        }
      }
      if (method === 'fs.mkdir') { await fs.mkdir(await resolvePath(params.dirPath, true)); return { success: true } }
      if (method === 'exec.run') {
        if (typeof params.command !== 'string' || params.command.length > 100000) throw new Error('Invalid app command')
        return execute('bash', { command: params.command, description: `App ${session.toolName || 'HTML'} command`, cwd: session.rootPath,
          timeoutMs: Math.min(180000, Math.max(1000, Number(params.timeout) || 180000)) })
      }
      if (method === 'customTool.invoke') {
        if (!session.toolName || (params.name && params.name !== session.toolName)) throw new Error('Cross-app custom tool invocation is not allowed')
        return customToolManager({ action: 'invoke', name: session.toolName, args: params.args ?? {} }, { rootPath: session.rootPath ?? undefined, cwd: session.rootPath ?? undefined, operationMode: session.mode })
      }
      if (method === 'tools.invoke') {
        if (typeof params.tool !== 'string' || params.tool.length > 200) throw new Error('Invalid app tool')
        return execute(params.tool, params.args ?? {})
      }
      if (method === 'http.request') return appHttpRequest(params)
    }).catch(error => ({ success: false, error: error instanceof Error ? error.message : 'App command failed' }))
    if (recordReceipt && !existing) receipts.set(key, { fingerprint, result })
    const value = await result
    if (recordReceipt && !existing && sessions.has(sessionId)) {
      const encoded = JSON.stringify(value)
      receipts.set(key, { fingerprint, result: Promise.resolve(encoded.length <= 65536 ? value : { success: value?.success === true, outcomeOnly: true, message: 'Command already executed; large result not retained. Do not repeat the side effect.' }) })
    }
    res.json(value)
  })
}
