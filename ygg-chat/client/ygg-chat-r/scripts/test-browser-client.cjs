// Shared production UI smoke with an isolated host fixture, no real database/account.
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const express = require('express')
  const fs = require('node:fs')
  const os = require('node:os')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-browser-smoke-'))
  app.setPath('userData', userData)
  let server
  const windows = []
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Browser client smoke timed out'); app.exit(1) }, 30000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const host = express()
    host.use(express.json())
    const snapshot = slot => ({ slot, status: 'signed_out', version: 1, sessionId: null, userId: null, email: null, expiresAt: null })
    const auth = { epoch: 'fixture-epoch', app: snapshot('app'), codex: snapshot('codex'), user: null }
    host.get('/api/host/runtime', (_req, res) => res.json({ protocol: 1, epoch: auth.epoch, hostId: 'fixture-host', auth, capabilities: { browserUi: true, sharedRuns: false } }))
    host.get('/api/host/execution-preferences', (_req, res) => res.json({ hostId: 'fixture-host', epoch: auth.epoch, revision: 0, values: {} }))
    host.get('/api/host/prompts', (_req, res) => res.json({ schema: 1, hostId: 'fixture-host', epoch: auth.epoch, revision: 0, prompts: [] }))
    host.get('/api/host/auth/status', (_req, res) => res.json(auth))
    host.get('/api/host/auth/events', (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write(`data: ${JSON.stringify(auth)}\n\n`) })
    host.get('/api/custom-tools', (_req, res) => res.json({ tools: [] }))
    host.get('/api/mcp/tools', (_req, res) => res.json({ tools: [] }))
    host.use('/api', (_req, res) => res.json([]))
    host.use(express.static(path.join(__dirname, '../dist-browser')))
    server = host.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    for (let i = 0; i < 2; i++) {
      const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, partition: `browser-fixture-${i}` } })
      windows.push(window)
      await window.loadURL(`http://127.0.0.1:${server.address().port}/#/login`)
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await window.webContents.executeJavaScript("document.body.innerText.includes('Continue locally')")
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const result = await window.webContents.executeJavaScript(`({ native: !!window.electronAPI, login: document.body.innerText.includes('Continue locally'), route: location.hash })`)
      if (result.native || !result.login || result.route !== '#/login') throw new Error(`Browser bootstrap failed: ${JSON.stringify(result)}`)
      console.log(`PASS production browser client ${i + 1}: no preload; host identity bootstrap; shared login mounted`)
    }
    exitCode = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout)
    for (const window of windows) window.destroy()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
    app.exit(exitCode)
  })
}
