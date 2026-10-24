// Crashes ONLY an isolated fixture renderer, never the running Graviton/profile.
// Run: node scripts/test-renderer-recovery-electron.cjs
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const http = require('node:http')
  const os = require('node:os')
  const assert = require('node:assert/strict')
  const { build } = require('esbuild')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-renderer-recovery-'))
  app.setPath('userData', userData)
  let window, server, heartbeat, recovery
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Recovery smoke timed out'); app.exit(1) }, 60000)
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Recovery condition timed out')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  app.whenReady().then(async () => {
    app.dock?.hide()
    const bundle = await build({
      entryPoints: [path.join(__dirname, '../electron/rendererRecovery.ts')],
      bundle: true, write: false, platform: 'node', format: 'cjs',
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports)
    const { installRendererRecovery } = module.exports
    let tick = 0, reads = 0, submits = 0, unavailable = false
    heartbeat = setInterval(() => tick++, 20)
    server = http.createServer((req, res) => {
      if (unavailable) { res.destroy(); return }
      if (req.url === '/state') {
        reads++
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ runId: 'surviving-host-run', tick, submits }))
      } else if (req.url === '/start' && req.method === 'POST') {
        submits++
        res.end('started')
      } else {
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html><body>Recovery fixture<script>fetch("/state").then(r=>r.json()).then(s=>window.hostState=s)</script></body></html>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const entryUrl = `http://127.0.0.1:${server.address().port}/`
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    const id = window.id
    const records = [], dialogs = []
    recovery = installRendererRecovery(window, {
      entryUrl, isQuitting: () => false,
      versions: { app: 'fixture', electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
      log: record => records.push(record), logPath: () => path.join(userData, 'fixture.ndjson'), changed: () => {},
      showDialog: options => {
        dialogs.push(options)
        const response = nextResponse
        nextResponse = 1
        return Promise.resolve({ response })
      },
    })
    await recovery.load()
    await window.webContents.executeJavaScript('location.hash="/chat/project/conversation"; fetch("/start", {method:"POST"})')
    await waitFor(() => submits === 1)
    await waitFor(async () => Boolean(await window.webContents.executeJavaScript('window.hostState')))
    const initial = await window.webContents.executeJavaScript('window.hostState')
    const shown = new Promise(resolve => window.once('show', resolve))
    window.show()
    await shown
    window.hide()
    assert.equal(window.isFocused(), false)
    window.webContents.forcefullyCrashRenderer()
    await waitFor(() => recovery.needsRecovery())
    assert.equal(dialogs.length, 0)
    assert.equal(window.isVisible(), false)
    assert.equal(window.isFocused(), false)
    assert.equal(records[0].event, 'failed')
    assert.equal(typeof records[0].reason, 'string')
    assert.equal(typeof records[0].exitCode, 'number')
    const during = tick
    await new Promise(resolve => setTimeout(resolve, 100))
    assert(tick > during, 'main-owned host must keep running')
    console.log('PASS actual renderer exit recorded while hidden; host survives without forced focus')

    // Exercise the same explicit native-dialog entry with injected user choices.
    recovery.recover()
    await waitFor(() => dialogs.length === 1)
    assert.equal(recovery.needsRecovery(), true)
    console.log('PASS Later retains native recovery entry without automatic reload')
    nextResponse = 0
    recovery.recover()
    await waitFor(() => !recovery.needsRecovery() && records.some(r => r.event === 'document_loaded'))
    await waitFor(async () => Boolean(await window.webContents.executeJavaScript('window.hostState')))
    const resumed = await window.webContents.executeJavaScript('window.hostState')
    assert.equal(window.id, id)
    assert(window.webContents.getURL().endsWith('#/chat/project/conversation'))
    assert.equal(resumed.runId, initial.runId)
    assert(resumed.tick > initial.tick)
    assert.equal(submits, 1)
    assert(reads >= 2)
    console.log('PASS same window and route reload; synthetic HTTP state reconnects (not real Chat reattachment)')

    nextResponse = 1
    window.webContents.forcefullyCrashRenderer()
    await waitFor(() => recovery.needsRecovery() && records.filter(r => r.event === 'failed').length === 2)
    unavailable = true
    nextResponse = 0
    recovery.recover()
    // The automatic failure dialog must choose Later, not retry in a loop.
    await waitFor(() => records.some(r => r.event === 'reload_failed'))
    await waitFor(() => recovery.needsRecovery())
    assert.equal(submits, 1)
    assert.equal(window.id, id)
    console.log('PASS repeated crash and failed reload remain recoverable without restarting the host')

    // Match production file:// loading too, including a path with spaces.
    recovery.dispose()
    const file = path.join(userData, 'fixture app.html')
    fs.writeFileSync(file, '<!doctype html><body>Packaged entry fixture</body>')
    const fileEntry = require('node:url').pathToFileURL(file).href
    const fileRecords = []
    recovery = installRendererRecovery(window, {
      entryUrl: fileEntry, isQuitting: () => false,
      versions: { app: 'fixture', electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
      log: record => fileRecords.push(record), logPath: () => path.join(userData, 'fixture.ndjson'), changed: () => {},
      showDialog: () => Promise.resolve({ response: 0 }),
    })
    await recovery.load()
    await window.webContents.executeJavaScript('location.hash="/chat/p/file-route"')
    window.webContents.forcefullyCrashRenderer()
    await waitFor(() => fileRecords.some(r => r.event === 'document_loaded'))
    assert.equal(window.id, id)
    assert.equal(window.webContents.getURL(), `${fileEntry}#/chat/p/file-route`)
    console.log('PASS packaged-style file entry with spaces and hash reloads after actual crash')
    exitCode = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout)
    clearInterval(heartbeat)
    recovery?.dispose()
    window?.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* Chromium may retain cache handles until exit. */ }
    app.exit(exitCode)
  })
  let nextResponse = 1
}
