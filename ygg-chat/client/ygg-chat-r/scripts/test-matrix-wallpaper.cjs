// Isolated production-asset Electron check. Never opens the user's Graviton profile.
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
  const os = require('node:os')
  const { pathToFileURL } = require('node:url')
  const { build } = require('esbuild')
  const assert = require('node:assert/strict')
  const root = path.join(__dirname, '..')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-matrix-'))
  app.setPath('userData', path.join(temp, 'profile'))
  let window
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Matrix wallpaper smoke timed out'); app.exit(1) }, 90000)
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await window.webContents.executeJavaScript(expression)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(message)
  }
  app.whenReady().then(async () => {
    app.dock?.hide()
    const assets = path.join(root, 'dist-electron', 'wallpapers', 'matrix')
    assert.ok(fs.existsSync(path.join(assets, 'wallpaper.html')), 'Build desktop renderer first')
    const localBase = pathToFileURL(path.join(root, 'dist-electron') + path.sep).href
    const bundle = await build({
      stdin: { contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import VideoBackground from './src/components/VideoBackground';
        import Controls from './src/components/MatrixBackgroundSettings';
        import {persistBackgroundMode} from './src/helpers/videoBackgroundStorage';
        localStorage.clear(); persistBackgroundMode('matrix');
        window.statuses=[]; window.addEventListener('message',e=>{ if(e.data?.type==='graviton:matrix-status')window.statuses.push(e.data.status) });
        const root=createRoot(document.getElementById('root'));
        const render=()=>root.render(<><VideoBackground/><Controls mode='matrix' onModeChange={persistBackgroundMode}/></>);
        render(); window.render=render; window.setMode=persistBackgroundMode;
      `, resolveDir: root, loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ BASE_URL: localBase }), __IS_ELECTRON__: 'true', __IS_LOCAL__: 'false', __IS_WEB__: 'false', __BUILD_TARGET__: '"electron"' },
      plugins: [{ name: 'isolated-theme', setup(builder) {
        builder.onLoad({ filter: /[/\\]ThemeManager[/\\]themeConfig\.ts$/ }, () => ({ contents: 'export const useCustomChatTheme=()=>({enabled:false,theme:{colors:{appBackgroundColor:{light:"#fff",dark:"#000"}}}}); export const useHtmlDarkMode=()=>false; export const getThemeModeColor=(p,d)=>p[d?"dark":"light"];' }))
      } }],
    })
    const html = path.join(temp, 'fixture.html')
    fs.writeFileSync(html, '<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%;}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;pointer-events:none}section{display:none}</style></head><body><div id="root"></div></body></html>')
    window = new BrowserWindow({ show: false, width: 720, height: 480, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const requests = []
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      requests.push(details.url)
      callback({ cancel: /^https?:/.test(details.url) })
    })
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
    await window.loadFile(html)
    await window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    await waitFor('window.statuses.includes("ready")', 'Local loadFile Matrix renderer did not become ready')
    assert.ok(!requests.some(url => /^https?:/.test(url)), 'No runtime network dependencies')
    console.log('PASS packaged file assets load offline and renderer becomes ready')
    await waitFor('document.documentElement.classList.contains("video-text-light")', 'Matrix did not enable light text')
    await new Promise(resolve => setTimeout(resolve, 800))
    const image = await window.webContents.capturePage()
    const pixels = image.toBitmap()
    let greenPixels = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 35 && pixels[i + 1] > pixels[i + 2] * 1.1) greenPixels++
    assert.ok(greenPixels > 100, `Expected visible rendered rain, found ${greenPixels} green pixels`)
    console.log('PASS actual WebGL rain renders behind the app with light text')
    const staticFrame = (await window.webContents.capturePage()).toPNG()
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.ok(staticFrame.equals((await window.webContents.capturePage()).toPNG()), 'Reduced-motion launch must draw a static frame')
    console.log('PASS reduced-motion launch draws visible static rain without animation')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    for (const preset of ['resurrections', 'operator']) {
      const readyCount = await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length')
      await window.webContents.executeJavaScript(`(()=>{const select=document.querySelector('select'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${JSON.stringify(preset)}); select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
      await waitFor(`statuses.filter(s=>s==='ready').length>${readyCount}`, `Preset ${preset} did not load`)
      assert.ok(!await window.webContents.executeJavaScript('statuses.includes("error")'), `Preset ${preset} failed`)
    }
    console.log('PASS presets reload their local glyph assets')
    const sliderReadyCount = await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length')
    await window.webContents.executeJavaScript(`(()=>{const input=document.querySelectorAll('input[type=range]')[1];const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const value of ['40','60','90']){setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length'), sliderReadyCount, 'Slider saves should be debounced')
    await waitFor(`statuses.filter(s=>s==='ready').length>${sliderReadyCount}`, 'Debounced slider value did not load')
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length'), sliderReadyCount + 1, 'Slider drag should rebuild once')
    console.log('PASS slider changes debounce into one renderer reload')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await new Promise(resolve => setTimeout(resolve, 200))
    const frozen = (await window.webContents.capturePage()).toPNG()
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.ok(frozen.equals((await window.webContents.capturePage()).toPNG()), 'Reduced motion must stop drawing')
    console.log('PASS reduced motion freezes the wallpaper')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(!frozen.equals((await window.webContents.capturePage()).toPNG()), 'Animation must resume')
    console.log('PASS animation resumes after reduced motion clears')
    await window.webContents.executeJavaScript('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
    await new Promise(resolve => setTimeout(resolve, 200))
    const hiddenFrame = (await window.webContents.capturePage()).toPNG()
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(hiddenFrame.equals((await window.webContents.capturePage()).toPNG()), 'Hidden document must stop drawing')
    await window.webContents.executeJavaScript('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))')
    window.setSize(840, 520)
    await new Promise(resolve => setTimeout(resolve, 300))
    console.log('PASS visibility pause and window resizing')
    const child = window.webContents.mainFrame.frames.find(frame => frame.url.includes('wallpaper.html'))
    assert.ok(child, 'Wallpaper frame exists')
    await child.executeJavaScript('document.querySelector("canvas").getContext("webgl").getExtension("WEBGL_lose_context").loseContext()')
    await waitFor('!document.querySelector("iframe")', 'Context loss did not remove renderer')
    console.log('PASS context loss removes GPU frame and keeps solid fallback')
    const count = await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length')
    await waitFor(`statuses.filter(s=>s==='ready').length>${count}`, 'Matrix did not automatically recover')
    console.log('PASS context loss automatically restarts with bounded retry')
    for (let i = 0; i < 2; i++) {
      const readyCount = await window.webContents.executeJavaScript('statuses.filter(s=>s==="ready").length')
      await window.webContents.executeJavaScript(`(()=>{const iframe=document.querySelector('iframe');window.dispatchEvent(new MessageEvent('message',{source:iframe.contentWindow,data:{type:'graviton:matrix-status',status:'error'}}));})()`)
      if (i === 0) await waitFor(`statuses.filter(s=>s==='ready').length>${readyCount}`, 'Second recovery did not start')
    }
    await waitFor('!document.querySelector("iframe")', 'Retry limit did not retain fallback')
    await new Promise(resolve => setTimeout(resolve, 1800))
    assert.ok(!await window.webContents.executeJavaScript('document.querySelector("iframe")!==null'), 'Retries must stop after two failures')
    console.log('PASS repeated failures stop retrying and retain solid fallback')
    await window.webContents.executeJavaScript('window.setMode("color")')
    await waitFor('!document.documentElement.classList.contains("video-text-light")', 'Text mode did not reset')
    await window.webContents.executeJavaScript('window.setMode("matrix")')
    await waitFor('document.querySelector("iframe")', 'Matrix could not be re-enabled')
    console.log('PASS switching modes disposes and recreates wallpaper')
    exitCode = 0
  }).catch(error => console.error(error)).finally(() => {
    clearTimeout(timeout)
    window?.destroy()
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* Chromium can hold cache handles until exit. */ }
    app.exit(exitCode)
  })
}
