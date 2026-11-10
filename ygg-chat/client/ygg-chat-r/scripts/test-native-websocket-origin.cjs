const { spawnSync } = require('node:child_process')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  process.exit(spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' }).status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-ws-origin-'))
  app.setPath('userData', root)
  const html = path.join(root, 'fixture.html'); fs.writeFileSync(html, '<!doctype html><body>Native origin fixture</body>')
  let window
  let postOrigin
  const server = http.createServer((request, response) => { postOrigin = request.headers.origin; response.setHeader('Access-Control-Allow-Origin', '*'); response.end('{}') })
  const timeout = setTimeout(() => app.exit(1), 15000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const origin = new Promise(resolve => server.once('upgrade', (request, socket) => { resolve(request.headers.origin); socket.destroy() }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await window.loadFile(html)
    await window.webContents.executeJavaScript(`new WebSocket('ws://127.0.0.1:${server.address().port}/ide-context'); void 0`)
    console.log('Native loadFile WebSocket Origin:', await origin)
    await window.webContents.executeJavaScript(`fetch('http://127.0.0.1:${server.address().port}/api/fixture',{method:'POST',body:'fixture'}).catch(()=>{});void 0`)
    for(let i=0;i<100&&postOrigin===undefined;i++)await new Promise(resolve=>setTimeout(resolve,10))
    console.log('Native loadFile POST Origin:', postOrigin)
  }).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    clearTimeout(timeout); window?.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode ?? 0)
  })
}
