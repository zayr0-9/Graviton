// Validate browser assets inside the actual built ASAR without launching real
// user-data, credentials, hooks or providers. No app process is started.
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const fs = require('node:fs')
  const express = require('express')
  const { build } = require('esbuild')
  const os = require('node:os')
  ;(async () => {
    const archive = path.join(__dirname, '../release/mac-arm64/Graviton.app/Contents/Resources/app.asar')
    if (!fs.existsSync(archive)) throw new Error('Package the unsigned --dir app first')
    // Parse actual packaged entrypoints too; asset/PTY tests alone never load main.
    const { assertNodeSyntax } = await import('./node-esm.mjs')
    for (const name of ['main.mjs', 'preload.mjs', 'toolRuntimeUtility.mjs', 'localAnalyticsWorker.mjs']) {
      assertNodeSyntax(path.join(archive, 'electron', name))
    }
    console.log('PASS ASAR Electron entrypoint syntax')
    const root = path.join(archive, 'dist-browser')
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(value => value[1]).filter(value => !/^(https?:|data:|#)/.test(value))
    for (const asset of assets) if (!fs.existsSync(path.join(root, asset.replace(/^\//, '')))) throw new Error(`Missing ASAR asset ${asset}`)
    const module = await build({ entryPoints: [path.join(__dirname, '../server/routes/browserUiRoutes.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['express'] })
    const loaded = { exports: {} }
    new Function('require', 'module', 'exports', module.outputFiles[0].text)(require, loaded, loaded.exports)
    const host = express(); loaded.exports.registerBrowserUiRoutes(host, root)
    const server = host.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      const index = await fetch(origin)
      if (!index.ok || !(await index.text()).includes('<html')) throw new Error('ASAR index not served')
      for (const asset of assets) if (!(await fetch(origin + '/' + asset.replace(/^\//, ''))).ok) throw new Error(`ASAR asset not served: ${asset}`)
      if ((await fetch(origin + '/assets/missing.js')).status !== 404 || (await fetch(origin + '/api/missing')).status !== 404) throw new Error('Asset/API fallback returned index')
      const runtime = path.join(archive, 'node_modules/node-pty')
      if (!fs.existsSync(path.join(runtime, 'package.json'))) throw new Error('PTY package absent from ASAR')
      const pty = require(runtime)
      const process = pty.spawn('/bin/sh', ['-c', 'printf packaged-pty'], { cols: 80, rows: 24, cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin' } })
      let output = ''
      process.onData(data => { output += data })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { process.kill(); reject(new Error('Packaged PTY timed out')) }, 5000)
        process.onExit(() => { clearTimeout(timer); output.includes('packaged-pty') ? resolve() : reject(new Error('Packaged PTY produced no output')) })
      })
      console.log(`PASS ASAR browser index + ${assets.length} entry assets, missing asset/API 404, packaged native PTY`)
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
