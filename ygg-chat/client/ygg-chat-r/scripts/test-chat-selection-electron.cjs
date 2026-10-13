// Real React/Redux/router lifecycle check, isolated from Graviton and its data.
// Run: node scripts/test-chat-selection-electron.cjs (requires a desktop session).
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-selection-smoke-'))
  app.setPath('userData', userData)
  let server
  let window
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Selection smoke timed out'); app.exit(1) }, 30000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const bundle = await build({
      entryPoints: [path.join(__dirname, 'chat-selection-browser-smoke.tsx')],
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __IS_ELECTRON__: 'false', __IS_LOCAL__: 'true', __IS_WEB__: 'false', __BUILD_TARGET__: '"local"' },
      plugins: [{ name: 'isolated-transports', setup(builder) {
        builder.onLoad({ filter: /[/\\]useAuth\.ts$/ }, () => ({ contents: 'export const useAuth = () => ({ accessToken: null })' }))
        builder.onLoad({ filter: /[/\\]conversationMessagesApi\.ts$/ }, () => ({ contents: 'export const fetchConversationMessagesTree = (...args) => window.__fetchSnapshot(...args)' }))
        builder.onLoad({ filter: /[/\\]utils[/\\]api\.ts$/ }, () => ({ contents: 'export const gwApi = { get: () => Promise.resolve({pathMessageIds: []}) }' }))
      } }],
    })
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'")
      res.end('<!doctype html><html><body><div id="root"></div></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
    await window.loadURL(`http://127.0.0.1:${server.address().port}/#/chat/p/a`)
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const checks = await window.webContents.executeJavaScript('window.__runSelectionSmoke()')
    for (const check of checks) console.log(`PASS ${check}`)
    exitCode = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout)
    window?.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* OS may retain Chromium cache handles until exit. */ }
    app.exit(exitCode)
  })
}
