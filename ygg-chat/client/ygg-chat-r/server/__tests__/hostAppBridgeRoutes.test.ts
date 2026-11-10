import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { registerHostAppBridgeRoutes } from '../routes/hostAppBridgeRoutes.js'
it('bounds app context, preserves file conflicts, scopes retries and rejects unknown methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-bridge-test-'))
  const app = express(); app.use(express.json()); registerHostAppBridgeRoutes(app)
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (route: string, body: any) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, value: await response.json() as any }
  }
  try {
    await writeFile(join(root, 'file'), 'original')
    const session = (await post('/api/host/apps/sessions', { rootPath: root, mode: 'execute', toolName: 'fixture' })).value.id
    const command = (requestId: string, method: string, params: any) => post(`/api/host/apps/sessions/${session}/commands`, { requestId, method, params })
    const first = await command('read', 'fs.readFile', { filePath: 'file' })
    expect(first.value.content).toBe('original')
    const saved = await command('write', 'fs.writeFile', { filePath: 'file', content: 'saved', expectedHash: first.value.hash })
    expect(saved.value.success).toBe(true)
    expect((await command('write', 'fs.writeFile', { filePath: 'file', content: 'saved', expectedHash: first.value.hash })).value).toEqual(saved.value)
    expect((await command('write', 'fs.writeFile', { filePath: 'file', content: 'other', expectedHash: first.value.hash })).status).toBe(409)
    expect((await command('stale', 'fs.writeFile', { filePath: 'file', content: 'stale', expectedHash: first.value.hash })).value.success).toBe(false)
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('saved')
    expect((await command('outside', 'fs.readFile', { filePath: '../outside' })).value.success).toBe(false)
    expect((await command('namespace', 'storage.get', { key: 'auth_session' })).status).toBe(400)
    const plan = (await post('/api/host/apps/sessions', { rootPath: root, mode: 'plan' })).value.id
    expect((await post(`/api/host/apps/sessions/${plan}/commands`, { requestId: 'no', method: 'fs.mkdir', params: { dirPath: 'new' } })).value.success).toBe(false)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
