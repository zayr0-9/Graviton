// Real Mermaid/React remount and layout checks, isolated from application data.
// Run: node scripts/test-mermaid-electron.cjs (requires a desktop session).
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const http = require('node:http')
  const os = require('node:os')
  const { build } = require('esbuild')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-mermaid-smoke-'))
  app.setPath('userData', userData)
  let server
  let window
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Mermaid smoke timed out'); app.exit(1) }, 60000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const bundle = await build({
      entryPoints: [path.join(__dirname, 'mermaid-browser-smoke.tsx')],
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    })
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'")
      res.end('<!doctype html><html><body><div id="root"></div></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const checks = await window.webContents.executeJavaScript('window.__runMermaidSmoke()')
    for (const check of checks) console.log(`PASS ${check}`)
    exitCode = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout)
    window?.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* Chromium may retain cache handles until exit. */ }
    app.exit(exitCode)
  })
}
