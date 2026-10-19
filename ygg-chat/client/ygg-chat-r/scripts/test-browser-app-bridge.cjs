const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process'); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  process.exit(spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' }).status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron'); const express = require('express'); const { build } = require('esbuild')
  const fs = require('node:fs'); const os = require('node:os'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-app-bridge-')); app.setPath('userData', root)
  let server; let window; let exit = 1
  const timeout = setTimeout(() => app.exit(1), 30000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const host = express(); host.use(express.json()); let reads = 0
    host.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') res.end(); else next() })
    host.post('/api/host/apps/sessions', (req, res) => { if (req.headers.origin === 'null') { res.status(403).json({ error: 'Opaque app cannot mint a host context' }); return } res.json({ id: 'fixture-session' }) })
    host.post('/api/host/apps/sessions/:id/commands', (req, res) => { reads++; if (req.body.method !== 'fs.readFile') throw new Error('Unexpected bridge operation'); res.json({ success: true, content: 'host fixture content', hash: 'a'.repeat(64) }) })
    host.get('/app/main.js', (_req, res) => res.type('application/javascript').send(`import { marker } from './nested.js';
      let isolated=false;try{void parent.document.body}catch{isolated=true}
      let direct;try{direct=(await fetch('/api/host/apps/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status}catch{direct='blocked'};
      parent.postMessage({type:'fixture',isolated,direct,marker},'*');
      window.addEventListener('message',event=>{if(event.data.type==='FS_READ_FILE_RESPONSE')parent.postMessage({type:'fixture-result',value:event.data},'*')});
      parent.postMessage({type:'FS_READ_FILE',requestId:'read-one',options:{filePath:'file.txt'}},'*');`))
    host.get('/app/nested.js', (_req, res) => res.type('application/javascript').send(`export const marker='nested module loaded'`))
    host.get('/app/', (_req, res) => res.setHeader('Content-Security-Policy', "connect-src 'none'; form-action 'none'; worker-src 'none'").send('<!doctype html><script type="module" src="./main.js"></script>'))
    host.get('/', (_req, res) => res.send('<!doctype html><body><iframe id="app" sandbox="allow-scripts" src="/app/"></iframe></body>'))
    server = host.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const bundle = await build({ stdin: { contents: `import { attachMessageBridge } from './src/utils/iframeBridge'; import {setHostAppContextProvider} from './src/platform/hostAppClient';
      window.fixture=[];window.addEventListener('message',event=>{if(event.data?.type?.startsWith('fixture'))window.fixture.push(event.data)});
      setHostAppContextProvider(()=>({rootPath:'/fixture',mode:'plan'}));
      attachMessageBridge(()=>document.getElementById('app'),()=>null,()=>({toolName:'fixture'}));`, resolveDir: path.join(__dirname, '..'), loader: 'ts' },
      bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'import.meta.env': '{}', __IS_ELECTRON__: 'false', __IS_WEB__: 'false', __IS_LOCAL__: 'false' }, plugins: [{ name: 'fixture', setup(builder) {
        builder.onLoad({ filter: /platform[/\\]clientCapabilities\.ts$/ }, () => ({ contents: 'export const isBrowserClient=true;export const isHostClient=true;export const isNativeShell=false' }))
        builder.onLoad({ filter: /utils[/\\]api\.ts$/ }, () => ({ contents: `export const buildLocalApiUrl=async p=>'/api'+p;export const localApi={};export const createStreamingRequest=()=>{throw Error('not expected')}` }))
      } }] })
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    await window.loadURL(origin)
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    await window.webContents.executeJavaScript(`document.getElementById('app').src='/app/?reload=1'`)
    for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(`window.fixture.some(value=>value.type==='fixture-result')`)) break; await new Promise(resolve => setTimeout(resolve, 25)) }
    const result = await window.webContents.executeJavaScript('window.fixture')
    if (!result.some(value => value.type === 'fixture' && value.isolated && value.direct === 'blocked' && value.marker === 'nested module loaded')) throw new Error('Opaque module/host boundary failed: ' + JSON.stringify(result))
    if (!result.some(value => value.type === 'fixture-result' && value.value?.success && value.value?.content === 'host fixture content')) throw new Error('Typed parent read failed: ' + JSON.stringify(result))
    const before = reads
    await window.webContents.executeJavaScript(`window.postMessage({type:'FS_READ_FILE',requestId:'spoof',options:{filePath:'file.txt'}},'*')`)
    await new Promise(resolve => setTimeout(resolve, 100))
    if (reads !== before) throw new Error('Source spoof reached host')
    console.log('PASS opaque browser app: nested modules, parent DOM blocked, direct host mutation denied, typed read succeeds, source spoof rejected')
    exit = 0
  }).catch(error => console.error(error)).finally(async () => { clearTimeout(timeout); window?.destroy(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } try { fs.rmSync(root, { recursive: true, force: true }) } catch {} app.exit(exit) })
}
