// Real Chromium file-origin requests through production host policies and the
// renderer admission client. No providers, credentials or real user data.
const { spawnSync } = require('node:child_process')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  process.exit(spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' }).status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
  const { build } = require('esbuild'); const express = require('express'); const cors = require('cors')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-native-bootstrap-'))
  app.setPath('userData', root)
  let server; let window
  const requests = []
  const timeout = setTimeout(() => { console.error('Native bootstrap timed out', requests); app.exit(1) }, 30000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const compiled = await build({ stdin: { contents: `export { hostClientPolicy } from './server/routes/hostClientPolicy.ts'; export { opaqueMutationFence } from './server/nativeClientFence.ts'; export { createNativeHostSessionInstaller } from './electron/nativeHostSession.ts'`, resolveDir: path.join(__dirname, '..') }, bundle: true, write: false, platform: 'node', format: 'cjs' })
    const loaded = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports)
    const { hostClientPolicy, opaqueMutationFence, createNativeHostSessionInstaller } = loaded.exports
    const host = express(); host.use(cors({ origin: true, allowedHeaders: ['Content-Type'] }))
    host.use((req, _res, next) => { requests.push({ method: req.method, path: req.path, origin: req.headers.origin, site: req.headers['sec-fetch-site'] }); next() })
    host.use('/api', opaqueMutationFence); host.use(express.json()); host.use('/api/host', hostClientPolicy)
    host.get('/api/host/runtime', (_req, res) => res.json({ epoch: 'fixture-epoch' }))
    host.post('/api/conversations/c/admissions', (req, res) => {
      if (req.body.epoch !== 'fixture-epoch') throw new Error('Missing bootstrap epoch')
      res.json({ operationId: req.body.operationId, conversationId: 'c', streamId: 's', status: 'accepted' })
    })
    host.patch('/api/host/execution-preferences', (_req, res) => res.json({ success: true }))
    server = host.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const install = createNativeHostSessionInstaller(() => origin, id => id === window?.webContents.id)
    const client = await build({ stdin: { contents: `import { admitRun } from './src/features/chats/runAdmissionClient.ts'; window.sendFixture = () => admitRun('c', { operationId: 'op' }, new AbortController().signal)`, resolveDir: path.join(__dirname, '..') }, plugins: [{ name: 'isolated-platform', setup(builder) {
      builder.onResolve({ filter: /utils\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }))
      builder.onResolve({ filter: /services\/hostRuntimeBootstrap$/ }, () => ({ path: 'bootstrap', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api' ? `export const buildLocalApiUrl = async path => ${JSON.stringify(origin + '/api')} + path` : 'export const getHostRuntime = () => null' }))
    } }], bundle: true, write: false, platform: 'browser', format: 'iife' })
    fs.writeFileSync(path.join(root, 'fixture.html'), '<!doctype html><body>Native bootstrap fixture</body>')
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    // The session already exists: production must not rely on session-created.
    install(window.webContents.session)
    install(window.webContents.session) // Idempotent across main/floating windows.
    await window.loadFile(path.join(root, 'fixture.html'))
    await window.webContents.executeJavaScript(client.outputFiles[0].text)
    const receipt = await window.webContents.executeJavaScript('window.sendFixture()')
    if (receipt.status !== 'accepted') throw new Error('Native admission failed')
    const status = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/host/execution-preferences')}, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)`)
    if (status !== 200) throw new Error(`Native preference update failed: ${status}`)
    console.log('PASS native loadFile host bootstrap, renderer send admission and host preferences', JSON.stringify(requests))
  }).catch(error => { console.error(error, requests); process.exitCode = 1 }).finally(async () => {
    clearTimeout(timeout); window?.destroy(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode ?? 0)
  })
}
